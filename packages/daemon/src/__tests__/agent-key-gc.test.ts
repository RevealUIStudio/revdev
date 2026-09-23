/**
 * GAP-262 — agent-key GC uses PID liveness, not session started_at.
 * Quarantine and delete stay disabled: the sweep must not remove keys.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_KEY_QUARANTINE_DELETES_ENABLED,
  type AgentKeyGcReport,
  agentKeyGcHealth,
  isPidAlive,
  runAgentKeyGc,
} from '../agent-key-gc.js';
import { migrate } from '../storage/migrate.js';

const DB_TEST_TIMEOUT = 60_000;

async function freshDb(): Promise<{ db: PGlite; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'revdev-key-gc-'));
  const db = new PGlite(dir);
  await migrate(db);
  return { db, dir };
}

async function seedKey(
  db: PGlite,
  agentId: string,
  opts: { sessionPid?: number | null; startedDaysAgo?: number; processPid?: number | null },
): Promise<void> {
  await db.query(
    `INSERT INTO agent_identity (agent_id, did, fingerprint, public_key_pem)
     VALUES ($1, $2, $3, $4)`,
    [agentId, `did:revealfleet:${agentId}:fp`, `${agentId}-fp`, 'pem'],
  );
  await db.query(
    `INSERT INTO agent_identity_keys (fingerprint, agent_id, public_key_pem)
     VALUES ($1, $2, $3)`,
    [`${agentId}-fp`, agentId, 'pem'],
  );
  if (opts.sessionPid !== undefined) {
    await db.query(
      `INSERT INTO agent_sessions (id, env, task, pid)
       VALUES ($1, 'test', 'task', $2)`,
      [agentId, opts.sessionPid],
    );
    if (opts.startedDaysAgo !== undefined) {
      await db.query(
        `UPDATE agent_sessions
            SET started_at = NOW() - INTERVAL '1 day' * $2
          WHERE id = $1`,
        [agentId, opts.startedDaysAgo],
      );
    }
  }
  if (opts.processPid !== undefined && opts.processPid !== null) {
    await db.query(
      `INSERT INTO agent_processes (id, owner_agent, command, cwd, pid, status)
       VALUES ($1, $2, 'agent', '/', $3, 'running')`,
      [`proc-${agentId}`, agentId, opts.processPid],
    );
  }
}

async function keyCount(db: PGlite): Promise<{ identities: number; keys: number }> {
  const identities = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM agent_identity');
  const keys = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM agent_identity_keys');
  return { identities: identities.rows[0]?.n ?? 0, keys: keys.rows[0]?.n ?? 0 };
}

describe('GAP-262 agent-key GC', () => {
  let db: PGlite;
  let dir: string;

  afterEach(async () => {
    await db?.close().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('keeps the quarantine/delete gate closed', () => {
    expect(AGENT_KEY_QUARANTINE_DELETES_ENABLED).toBe(false);
    const src = readFileSync(new URL('../agent-key-gc.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/DELETE\s+FROM\s+agent_identity/i);
    expect(src).not.toMatch(/UPDATE\s+agent_identity/i);
  });

  it('treats this process as alive and a nonexistent pid as dead', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
    // Above typical pid_max; ESRCH rather than a live process.
    expect(isPidAlive(2_147_483_647)).toBe(false);
  });

  it(
    'classifies a long-running live PID as live even when started_at is old',
    async () => {
      ({ db, dir } = await freshDb());
      await seedKey(db, 'old-live', { sessionPid: 4242, startedDaysAgo: 30 });
      const before = await keyCount(db);

      const report = await runAgentKeyGc(db, {
        isPidAlive: (pid) => pid === 4242,
      });

      expect(report).toMatchObject({
        scanned: 1,
        live: 1,
        deadPid: 0,
        unproven: 0,
        quarantined: 0,
        deleted: 0,
        quarantineDeletesEnabled: false,
      } satisfies Partial<AgentKeyGcReport>);
      expect(await keyCount(db)).toEqual(before);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'classifies a fresh dead PID as a candidate and still does not delete keys',
    async () => {
      ({ db, dir } = await freshDb());
      await seedKey(db, 'fresh-dead', { sessionPid: 111, startedDaysAgo: 0 });
      const before = await keyCount(db);

      const report = await runAgentKeyGc(db, { isPidAlive: () => false });

      expect(report.deadPid).toBe(1);
      expect(report.live).toBe(0);
      expect(report.deleted).toBe(0);
      expect(report.quarantined).toBe(0);
      expect(await keyCount(db)).toEqual(before);
      const health = agentKeyGcHealth();
      expect(health.deadPid).toBe(1);
      expect(health.deleted).toBe(0);
      expect(health.quarantineDeletesEnabled).toBe(false);
      expect(health.lastRunAt).not.toBeNull();

      const still = await db.query<{ fingerprint: string }>(
        'SELECT fingerprint FROM agent_identity_keys WHERE agent_id = $1',
        ['fresh-dead'],
      );
      expect(still.rows.map((r) => r.fingerprint)).toEqual(['fresh-dead-fp']);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'does not treat a missing PID as dead, regardless of session age',
    async () => {
      ({ db, dir } = await freshDb());
      await seedKey(db, 'no-pid', { sessionPid: null, startedDaysAgo: 90 });
      await seedKey(db, 'no-session', {});

      const report = await runAgentKeyGc(db, { isPidAlive: () => false });

      expect(report.scanned).toBe(2);
      expect(report.unproven).toBe(2);
      expect(report.deadPid).toBe(0);
      expect(report.deleted).toBe(0);
      expect((await keyCount(db)).keys).toBe(2);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'uses a spawned process PID when the session PID is null',
    async () => {
      ({ db, dir } = await freshDb());
      await seedKey(db, 'spawned', { sessionPid: null, processPid: 777 });

      const live = await runAgentKeyGc(db, { isPidAlive: (pid) => pid === 777 });
      expect(live.live).toBe(1);
      expect(live.deadPid).toBe(0);

      const dead = await runAgentKeyGc(db, { isPidAlive: () => false });
      expect(dead.deadPid).toBe(1);
      expect(dead.deleted).toBe(0);
      expect((await keyCount(db)).identities).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'stays live when any recorded PID is alive',
    async () => {
      ({ db, dir } = await freshDb());
      await seedKey(db, 'mixed', { sessionPid: 1, processPid: 2 });

      const report = await runAgentKeyGc(db, { isPidAlive: (pid) => pid === 2 });
      expect(report.live).toBe(1);
      expect(report.deadPid).toBe(0);
      expect((await keyCount(db)).keys).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );
});
