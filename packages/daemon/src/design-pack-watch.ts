/**
 * GAP-323 item 3 — design-pack filesystem watcher (native pair of GAP-322).
 *
 * Watches the code-canonical design pack (`packages/tokens/design-context/`)
 * and the generated preview bundle (`preview-dist/`) under a RevealUI monorepo
 * root. On change, emits durable `design.pack.moved` events so any harness
 * (not only Claude DesignSync) can answer "did the design pack move?" without
 * a vendor login.
 *
 * Extend-before-create: reuses the events table + events.wait pattern from
 * GAP-362 work.completed (in-process bus + durable INSERT).
 */

import { createHash } from 'node:crypto';
import { createReadStream, type FSWatcher, watch } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createLogger } from '@revealui/utils/logger';
import {
  DESIGN_PACK_MOVED_EVENT,
  type DesignPackMovedPayload,
  designPackEvents,
} from './design-pack-events.js';
import { onDaemonStarted, onDaemonStopping } from './eviction.js';
import { syncEventLog } from './neon.js';
import { registerHandler } from './server.js';

export { DESIGN_PACK_MOVED_EVENT, designPackEvents, type DesignPackMovedPayload } from './design-pack-events.js';

const log = createLogger({ service: 'revdev-daemon/design-pack' });

/** Relative roots under a revealui monorepo (code-over-docs from GAP-323). */
export const DEFAULT_RELATIVE_ROOTS = [
  'packages/tokens/design-context',
  'preview-dist',
] as const;

const DEBOUNCE_MS = 250;
/** Cap walk depth so a mis-pointed root cannot fan out the whole disk. */
const MAX_WALK_DEPTH = 8;
/** Cap files hashed per snapshot (design pack is small; previews are flat HTML). */
const MAX_FILES = 2_000;

export interface PackFileEntry {
  rel: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface PackSnapshot {
  /** Absolute roots that were scanned (existed at scan time). */
  roots: string[];
  /** Aggregate of per-file content hashes (sorted). Empty roots → empty digest. */
  digest: string;
  files: PackFileEntry[];
  scannedAt: string;
}

// ---------------------------------------------------------------------------
// Pure path + snapshot helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Resolve absolute watch paths from a revealui monorepo root.
 * Does not require paths to exist (caller filters missing dirs).
 */
export function resolveWatchPaths(repoRoot: string): string[] {
  const root = resolve(repoRoot);
  return DEFAULT_RELATIVE_ROOTS.map((rel) => join(root, rel));
}

/**
 * Env-driven roots for auto-watch on daemon start.
 *
 * Priority:
 * 1. `REVDEV_DESIGN_PACK_ROOTS` — colon-separated absolute (or ~) paths
 * 2. `REVDEV_REVEALUI_ROOT` — monorepo root → default relative segments
 * 3. `$HOME/revfleet/revealui` when that tree contains design-context
 */
export function resolveAutoWatchRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = (env.REVDEV_DESIGN_PACK_ROOTS ?? '').trim();
  if (explicit) {
    return explicit
      .split(':')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => expandHome(p));
  }
  const revealui = (env.REVDEV_REVEALUI_ROOT ?? '').trim();
  if (revealui) {
    return resolveWatchPaths(expandHome(revealui));
  }
  const dogfood = join(homedir(), 'revfleet', 'revealui');
  return resolveWatchPaths(dogfood);
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith(`~${sep}`)) return join(homedir(), p.slice(2));
  return resolve(p);
}

function hashStream(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const h = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(h.digest('hex')));
  });
}

async function walkFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue;
    const full = join(root, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await walkFiles(full, depth + 1)));
    } else if (ent.isFile()) {
      out.push(full);
    }
    if (out.length >= MAX_FILES) break;
  }
  return out.slice(0, MAX_FILES);
}

/**
 * Snapshot content digests for existing roots. Missing roots are omitted
 * (so a missing preview-dist is not an error — it appears when generated).
 */
export async function snapshotPack(roots: string[]): Promise<PackSnapshot> {
  const existing: string[] = [];
  for (const r of roots) {
    try {
      const st = await stat(r);
      if (st.isDirectory()) {
        existing.push(await realpath(r));
      }
    } catch {
      // skip missing
    }
  }

  const files: PackFileEntry[] = [];
  for (const root of existing) {
    const absFiles = await walkFiles(root);
    for (const abs of absFiles) {
      try {
        const st = await stat(abs);
        if (!st.isFile()) continue;
        const sha256 = await hashStream(abs);
        const rel = abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs;
        files.push({
          rel: `${root.split(sep).slice(-2).join('/')}/${rel}`,
          size: st.size,
          mtimeMs: st.mtimeMs,
          sha256,
        });
      } catch {
        // race: file deleted mid-walk
      }
    }
  }

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const digest = createHash('sha256')
    .update(files.map((f) => `${f.rel}:${f.sha256}`).join('\n'))
    .digest('hex');

  return {
    roots: existing,
    digest: files.length === 0 ? '' : digest,
    files,
    scannedAt: new Date().toISOString(),
  };
}

export function diffSnapshots(
  prev: PackSnapshot | null,
  next: PackSnapshot,
): { changed: boolean; changedFiles: string[] } {
  if (!prev) {
    return {
      changed: next.files.length > 0 || next.roots.length > 0,
      changedFiles: next.files.map((f) => f.rel),
    };
  }
  if (prev.digest === next.digest) {
    return { changed: false, changedFiles: [] };
  }
  const prevMap = new Map(prev.files.map((f) => [f.rel, f.sha256]));
  const nextMap = new Map(next.files.map((f) => [f.rel, f.sha256]));
  const changedFiles: string[] = [];
  for (const [rel, hash] of nextMap) {
    if (prevMap.get(rel) !== hash) changedFiles.push(rel);
  }
  for (const rel of prevMap.keys()) {
    if (!nextMap.has(rel)) changedFiles.push(rel);
  }
  changedFiles.sort();
  return { changed: true, changedFiles };
}

// ---------------------------------------------------------------------------
// Watcher runtime
// ---------------------------------------------------------------------------

export interface DesignPackWatchStatus {
  watching: boolean;
  roots: string[];
  lastDigest: string | null;
  lastScannedAt: string | null;
  lastMovedAt: string | null;
  fileCount: number;
}

type LogMoved = (payload: DesignPackMovedPayload) => Promise<void>;

export class DesignPackWatcher {
  private watchers: FSWatcher[] = [];
  private roots: string[] = [];
  private lastSnapshot: PackSnapshot | null = null;
  private lastMovedAt: string | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private logMoved: LogMoved | null = null;
  private scanning = false;

  status(): DesignPackWatchStatus {
    return {
      watching: this.watchers.length > 0,
      roots: [...this.roots],
      lastDigest: this.lastSnapshot?.digest ?? null,
      lastScannedAt: this.lastSnapshot?.scannedAt ?? null,
      lastMovedAt: this.lastMovedAt,
      fileCount: this.lastSnapshot?.files.length ?? 0,
    };
  }

  async start(roots: string[], logMoved: LogMoved): Promise<DesignPackWatchStatus> {
    await this.stop();
    this.logMoved = logMoved;
    // Keep configured roots even if missing — watchers attach only to existing dirs.
    this.roots = [...new Set(roots.map((r) => resolve(r)))];

    this.lastSnapshot = await snapshotPack(this.roots);

    for (const root of this.roots) {
      try {
        const st = await stat(root);
        if (!st.isDirectory()) continue;
        const w = watch(root, { recursive: true }, () => this.scheduleScan());
        w.on('error', (err) => {
          log.warn('design-pack watch error', { root, error: String(err) });
        });
        // Do not keep the process alive solely for the design pack.
        // Node FSWatcher has no unref; process exit is still driven by the socket.
        this.watchers.push(w);
      } catch {
        // Missing root — status still lists it; appears when generated.
      }
    }

    log.info('design-pack watch started', {
      roots: this.roots,
      watching: this.watchers.length,
      digest: this.lastSnapshot.digest || '(empty)',
      files: this.lastSnapshot.files.length,
    });
    return this.status();
  }

  async stop(): Promise<void> {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers = [];
    this.logMoved = null;
  }

  private scheduleScan(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.scanAndEmit();
    }, DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  /**
   * Re-scan roots. Emits `design.pack.moved` only when the digest changes
   * relative to the current baseline (set on start). `force` re-emits a
   * moved event even when the digest is unchanged (tests / manual nudge).
   */
  async scanAndEmit(force = false): Promise<DesignPackMovedPayload | null> {
    if (this.scanning) return null;
    this.scanning = true;
    try {
      const next = await snapshotPack(this.roots);
      const previousDigest = this.lastSnapshot?.digest ?? null;
      const { changed, changedFiles } = diffSnapshots(this.lastSnapshot, next);

      if (!changed && !force) {
        // Refresh mtimes without emitting.
        this.lastSnapshot = next;
        return null;
      }

      const payload: DesignPackMovedPayload = {
        roots: next.roots,
        previousDigest,
        digest: next.digest,
        changedFiles:
          changedFiles.length > 0 ? changedFiles : next.files.map((f) => f.rel),
        fileCount: next.files.length,
        at: new Date().toISOString(),
      };

      this.lastSnapshot = next;
      this.lastMovedAt = payload.at;
      designPackEvents.emitMoved(payload);
      if (this.logMoved) {
        await this.logMoved(payload);
      }
      return payload;
    } finally {
      this.scanning = false;
    }
  }
}

/** Process-singleton watcher (one daemon = one design-pack watch). */
export const designPackWatcher = new DesignPackWatcher();

onDaemonStopping(() => designPackWatcher.stop());


// ---------------------------------------------------------------------------
// RPC registration
// ---------------------------------------------------------------------------

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function persistMoved(db: PGlite, payload: DesignPackMovedPayload): Promise<void> {
  await db.query(`INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
    'revdev-daemon',
    DESIGN_PACK_MOVED_EVENT,
    JSON.stringify(payload),
  ]);
  await syncEventLog({
    agentId: 'revdev-daemon',
    type: DESIGN_PACK_MOVED_EVENT,
    payload,
  });
}

/**
 * Shared start helper used by RPC + auto-watch.
 */
export async function startDesignPackWatch(
  db: PGlite,
  roots: string[],
): Promise<DesignPackWatchStatus> {
  return designPackWatcher.start(roots, (payload) => persistMoved(db, payload));
}

registerHandler('design.pack.status', async () => {
  return designPackWatcher.status();
});

registerHandler('design.pack.watch', async (params, db) => {
  const repoRoot = strOrNull(params.repoRoot);
  const pathsParam = params.paths;
  let roots: string[];
  if (Array.isArray(pathsParam) && pathsParam.length > 0) {
    roots = pathsParam
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => resolve(p));
  } else if (repoRoot) {
    roots = resolveWatchPaths(repoRoot);
  } else {
    roots = resolveAutoWatchRoots();
  }
  if (roots.length === 0) {
    throw new Error('design.pack.watch: no roots (set repoRoot, paths, or REVDEV_REVEALUI_ROOT)');
  }
  const status = await startDesignPackWatch(db, roots);
  return { ...status, started: true };
});

registerHandler('design.pack.unwatch', async () => {
  await designPackWatcher.stop();
  return { watching: false, stopped: true };
});

registerHandler('design.pack.scan', async (params, db) => {
  // Ensure a log path exists if someone scans before watch.
  if (!designPackWatcher.status().watching) {
    const roots =
      Array.isArray(params.paths) && params.paths.length > 0
        ? (params.paths as string[]).map((p) => resolve(p))
        : resolveAutoWatchRoots();
    await startDesignPackWatch(db, roots);
  }
  const force = params.force === true;
  const moved = await designPackWatcher.scanAndEmit(force);
  return {
    status: designPackWatcher.status(),
    moved,
  };
});

// Auto-watch on daemon start when a configured root exists (best-effort).
onDaemonStarted(async (db) => {
  const roots = resolveAutoWatchRoots();
  // Only auto-start when at least one root exists — avoid noisy empty watches
  // on machines without a local revealui checkout.
  let any = false;
  for (const r of roots) {
    try {
      const st = await stat(r);
      if (st.isDirectory()) {
        any = true;
        break;
      }
    } catch {
      /* */
    }
  }
  if (!any) {
    log.debug('design-pack auto-watch skipped (no roots present)', { roots });
    return;
  }
  try {
    await startDesignPackWatch(db, roots);
  } catch (err) {
    log.warn('design-pack auto-watch failed', { error: String(err) });
  }
});
