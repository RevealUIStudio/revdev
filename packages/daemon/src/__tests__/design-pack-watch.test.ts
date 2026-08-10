/**
 * GAP-323 design-pack watcher — pure snapshot + live FS watch emit.
 *
 * @vitest-environment node
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DesignPackWatcher,
  DESIGN_PACK_MOVED_EVENT,
  designPackEvents,
  diffSnapshots,
  resolveAutoWatchRoots,
  resolveWatchPaths,
  snapshotPack,
} from '../design-pack-watch.js';

describe('design-pack pure helpers', () => {
  it('resolveWatchPaths appends default relative roots', () => {
    const paths = resolveWatchPaths('/tmp/revealui-monorepo');
    expect(paths).toEqual([
      join('/tmp/revealui-monorepo', 'packages/tokens/design-context'),
      join('/tmp/revealui-monorepo', 'preview-dist'),
    ]);
  });

  it('resolveAutoWatchRoots prefers REVDEV_DESIGN_PACK_ROOTS', () => {
    const roots = resolveAutoWatchRoots({
      REVDEV_DESIGN_PACK_ROOTS: '/a/design-context:/b/preview-dist',
      REVDEV_REVEALUI_ROOT: '/should/not/use',
    });
    expect(roots).toEqual(['/a/design-context', '/b/preview-dist']);
  });

  it('resolveAutoWatchRoots uses REVDEV_REVEALUI_ROOT when pack roots unset', () => {
    const roots = resolveAutoWatchRoots({
      REVDEV_REVEALUI_ROOT: '/fleet/revealui',
      REVDEV_DESIGN_PACK_ROOTS: '',
    });
    expect(roots[0]).toContain(join('packages', 'tokens', 'design-context'));
  });

  it('snapshotPack digests file content and diffs on change', async () => {
    const root = join(tmpdir(), `dp-snap-${Date.now()}`);
    await mkdir(root, { recursive: true });
    try {
      await writeFile(join(root, 'tokens.css'), ':root { --x: 1; }\n', 'utf8');
      const a = await snapshotPack([root]);
      expect(a.roots).toHaveLength(1);
      expect(a.files.length).toBeGreaterThanOrEqual(1);
      expect(a.digest).toMatch(/^[a-f0-9]{64}$/);

      const b = await snapshotPack([root]);
      expect(diffSnapshots(a, b).changed).toBe(false);

      await writeFile(join(root, 'tokens.css'), ':root { --x: 2; }\n', 'utf8');
      const c = await snapshotPack([root]);
      const d = diffSnapshots(a, c);
      expect(d.changed).toBe(true);
      expect(d.changedFiles.some((f) => f.includes('tokens.css'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('snapshotPack omits missing roots', async () => {
    const snap = await snapshotPack([join(tmpdir(), `no-such-dir-${Date.now()}`)]);
    expect(snap.roots).toEqual([]);
    expect(snap.digest).toBe('');
    expect(snap.files).toEqual([]);
  });
});

describe('DesignPackWatcher', () => {
  afterEach(async () => {
    // ensure no leaked listeners between tests
    designPackEvents.removeAllListeners(DESIGN_PACK_MOVED_EVENT);
  });

  it('emits design.pack.moved when a watched file changes', async () => {
    const root = join(tmpdir(), `dp-watch-${Date.now()}`);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'MANIFEST.sha256'), 'v1\n', 'utf8');

    const watcher = new DesignPackWatcher();
    const logged: unknown[] = [];
    const busEvents: unknown[] = [];
    designPackEvents.on(DESIGN_PACK_MOVED_EVENT, (p) => busEvents.push(p));

    try {
      const status = await watcher.start([root], async (payload) => {
        logged.push(payload);
      });
      expect(status.watching).toBe(true);
      expect(status.fileCount).toBeGreaterThanOrEqual(1);
      expect(status.lastMovedAt).toBeNull();

      await writeFile(join(root, 'MANIFEST.sha256'), 'v2\n', 'utf8');
      // Debounce is 250ms; poll scan until moved or timeout.
      let moved = null;
      for (let i = 0; i < 40; i++) {
        moved = await watcher.scanAndEmit(false);
        if (moved) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(moved).not.toBeNull();
      expect(moved?.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(logged.length).toBeGreaterThanOrEqual(1);
      expect(busEvents.length).toBeGreaterThanOrEqual(1);
      expect(watcher.status().lastMovedAt).not.toBeNull();
    } finally {
      await watcher.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not emit on start baseline (equal re-scan)', async () => {
    const root = join(tmpdir(), `dp-base-${Date.now()}`);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.txt'), 'hello\n', 'utf8');
    const watcher = new DesignPackWatcher();
    try {
      await watcher.start([root], async () => {
        throw new Error('should not log on baseline re-scan');
      });
      const moved = await watcher.scanAndEmit(false);
      expect(moved).toBeNull();
    } finally {
      await watcher.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
