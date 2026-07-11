/**
 * GAP-326 — file-layer never-bound guards, UNIT coverage via the @internal
 * seams (no socket): the D1/D3 registration-refusal matrix, the D2 resolution
 * belt in isolation (a pre-fix persisted overlapping root seeded directly), and
 * the D3 startup eviction of a persisted overlapping row.
 *
 * The end-to-end attack + regression live in filegit-neverbound.test.ts (real
 * socket, no seams). This file drives the individual guards where a seam is the
 * cheapest faithful surface.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the eviction log line (D3) without a real logger. Only createLogger is
// stubbed; every other logger export keeps its real implementation.
const { warnCalls } = vi.hoisted(() => ({
  warnCalls: [] as Array<{ msg: string; meta: unknown }>,
}));
vi.mock('@revealui/utils/logger', async (importActual) => {
  const actual = await importActual<typeof import('@revealui/utils/logger')>();
  const stub = (): Record<string, unknown> => ({
    debug() {},
    info() {},
    error() {},
    fatal() {},
    warn(msg: string, meta?: unknown) {
      warnCalls.push({ msg, meta });
    },
    child() {
      return stub();
    },
  });
  return { ...actual, createLogger: () => stub() };
});

import {
  _addRootForTest,
  _assertRootAvoidsNeverBoundForTest,
  _clearRegisteredRootsForTest,
  _resetNeverBoundForTest,
  _resolveInRootForTest,
  _setNeverBoundForTest,
  restoreProjectRoots,
} from '../filegit.js';
import { MIGRATIONS } from '../migrations/index.js';
import { migrate } from '../storage/migrate.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ---------------------------------------------------------------------------
// D1/D3 registration-refusal matrix (pure — lexical fixtures, no fs)
// ---------------------------------------------------------------------------

describe('D1/D3 never-bound root gate — registration refusal matrix', () => {
  const HOME = '/base/op';
  const DATADIR = '/base/op/.local/share/revealui';

  afterEach(() => _resetNeverBoundForTest());

  it('refuses the operator home itself', () => {
    _setNeverBoundForTest(HOME, DATADIR);
    expect(() => _assertRootAvoidsNeverBoundForTest(HOME)).toThrow(/operator home/);
  });

  it('refuses an ancestor of the operator home', () => {
    _setNeverBoundForTest(HOME, DATADIR);
    expect(() => _assertRootAvoidsNeverBoundForTest('/base')).toThrow(/operator home/);
  });

  it('refuses a root that IS a secret path', () => {
    _setNeverBoundForTest(HOME, DATADIR);
    expect(() => _assertRootAvoidsNeverBoundForTest(join(HOME, '.ssh'))).toThrow(
      /never-bound secret path/,
    );
  });

  it('refuses a root INSIDE a secret path', () => {
    _setNeverBoundForTest(HOME, DATADIR);
    expect(() => _assertRootAvoidsNeverBoundForTest(join(HOME, '.ssh', 'sub'))).toThrow(
      /never-bound secret path/,
    );
  });

  it('refuses a root that CONTAINS a never-bound path (not the home itself)', () => {
    // Home elsewhere so this isolates "never-bound inside root" from the home check:
    // the root /base/proj contains the daemon data dir /base/proj/data.
    _setNeverBoundForTest('/other/home', '/base/proj/data');
    expect(() => _assertRootAvoidsNeverBoundForTest('/base/proj')).toThrow(
      /never-bound secret path/,
    );
  });

  it('names the CLASS, never the full secret path (no oracle back to a hostile caller)', () => {
    _setNeverBoundForTest(HOME, DATADIR);
    expect(() => _assertRootAvoidsNeverBoundForTest(join(HOME, '.ssh'))).toThrow(/ssh keys/);
    expect(() => _assertRootAvoidsNeverBoundForTest(join(HOME, '.ssh'))).not.toThrow(
      /\/base\/op\/\.ssh/,
    );
  });

  it('does NOT refuse a normal project root beneath the home', () => {
    _setNeverBoundForTest(HOME, DATADIR);
    expect(() => _assertRootAvoidsNeverBoundForTest(join(HOME, 'revfleet', 'repo'))).not.toThrow();
  });

  it('is separator-safe: a sibling sharing a name prefix is not refused', () => {
    _setNeverBoundForTest(HOME, DATADIR);
    expect(() => _assertRootAvoidsNeverBoundForTest('/base/op-scratch/repo')).not.toThrow();
    expect(() => _assertRootAvoidsNeverBoundForTest(join(HOME, '.sshkeep'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// D2 resolution belt in isolation — a pre-fix overlapping root cannot resolve
// a target onto the never-bound set (seed the root directly, bypassing D1).
// ---------------------------------------------------------------------------

describe('D2 resolution belt (isolation)', () => {
  let root: string;

  beforeEach(async () => {
    _clearRegisteredRootsForTest();
    root = await realpath(await mkdtemp(join(tmpdir(), 'revdev-nb-belt-')));
    await mkdir(join(root, 'secrets'));
    await writeFile(join(root, 'secrets', 'key.txt'), 'PRIVATE\n');
    await writeFile(join(root, 'ok.txt'), 'fine\n');
    // Simulate a pre-fix persisted row: register the overlapping root directly,
    // bypassing project.open's D1 gate.
    await _addRootForTest(root);
    // Pin never-bound so <root>/secrets is a secret path (the daemon dataDir entry).
    _setNeverBoundForTest('/no/such/home', join(root, 'secrets'));
  });

  afterEach(async () => {
    _resetNeverBoundForTest();
    _clearRegisteredRootsForTest();
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a read target inside the never-bound set (mustExist=true)', async () => {
    await expect(_resolveInRootForTest(root, 'secrets/key.txt', true)).rejects.toThrow(
      /never-bound secret path/,
    );
  });

  it('refuses a write target inside the never-bound set (mustExist=false)', async () => {
    await expect(_resolveInRootForTest(root, 'secrets/new.txt', false)).rejects.toThrow(
      /never-bound secret path/,
    );
  });

  it('still resolves a legit target that does not overlap', async () => {
    await expect(_resolveInRootForTest(root, 'ok.txt', true)).resolves.toBe(join(root, 'ok.txt'));
  });
});

// ---------------------------------------------------------------------------
// D3 startup eviction — restoreProjectRoots evicts a persisted overlapping (or
// non-repo) row, keeps the clean one, and logs each eviction.
// ---------------------------------------------------------------------------

describe('D3 startup re-validation (restoreProjectRoots eviction)', () => {
  let db: PGlite;
  let scratchDataDir: string;
  let overlapRepo: string;
  let cleanRepo: string;
  let nonRepoRow: string;

  beforeEach(async () => {
    warnCalls.length = 0;
    _clearRegisteredRootsForTest();
    db = new PGlite();
    await migrate(db, MIGRATIONS);

    scratchDataDir = await realpath(await mkdtemp(join(tmpdir(), 'revdev-nb-evict-')));
    // An active (not-ended) session so the rows are not treated as orphans.
    await db.query(`INSERT INTO agent_sessions (id) VALUES ($1)`, ['evict-agent']);

    overlapRepo = join(scratchDataDir, 'overlap-repo');
    execFileSync('mkdir', ['-p', overlapRepo]);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: overlapRepo });

    cleanRepo = await realpath(await mkdtemp(join(tmpdir(), 'revdev-nb-clean-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: cleanRepo });

    nonRepoRow = await realpath(await mkdtemp(join(tmpdir(), 'revdev-nb-nonrepo-')));

    for (const p of [overlapRepo, cleanRepo, nonRepoRow]) {
      const s = await stat(p);
      await db.query(
        `INSERT INTO project_roots (dev, ino, real_path, agent_id) VALUES ($1, $2, $3, $4)`,
        [BigInt(s.dev), BigInt(s.ino), p, 'evict-agent'],
      );
    }

    // Pin never-bound: <scratchDataDir> is the daemon data dir (never-bound), so
    // overlapRepo (inside it) overlaps; cleanRepo / nonRepoRow do not.
    _setNeverBoundForTest('/no/such/home', scratchDataDir);
  });

  afterEach(async () => {
    _resetNeverBoundForTest();
    _clearRegisteredRootsForTest();
    await db.close().catch(() => {});
    for (const p of [scratchDataDir, cleanRepo, nonRepoRow]) {
      await rm(p, { recursive: true, force: true });
    }
  });

  it('evicts the overlapping + non-repo rows, keeps the clean one, and logs each eviction', async () => {
    await restoreProjectRoots(db);

    const rows = await db.query<{ real_path: string }>(`SELECT real_path FROM project_roots`);
    const survivors = rows.rows.map((r) => r.real_path);
    expect(survivors).toContain(cleanRepo);
    expect(survivors).not.toContain(overlapRepo);
    expect(survivors).not.toContain(nonRepoRow);

    const evictions = warnCalls.filter((c) => c.msg.includes('evicting persisted project root'));
    expect(evictions.length).toBe(2);
  });
});
