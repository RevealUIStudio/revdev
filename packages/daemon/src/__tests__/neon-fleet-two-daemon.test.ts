/**
 * GAP-154 residual — two-daemon fleet visibility (same process, shared Neon mock).
 *
 * Acceptance slice from GAP-154.yml verify:
 *   daemon A registers session "foo"; daemon B's
 *   `session.list({ scope: 'fleet' })` returns "foo".
 *
 * Real multi-host + Neon still needs POSTGRES_URL on two machines; this test
 * proves the dual-write + fleet-read path without a network Neon by injecting
 * one shared stateful mock via setNeonClientForTesting (process-global).
 *
 * Complements neon-sync.test.ts (single daemon, canned SELECT). That suite
 * does not prove A→Neon→B.
 *
 * @vitest-environment node
 */
import { vi } from 'vitest';

vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _resetForTesting, setNeonClientForTesting } from '../neon.js';
import { startDaemon } from '../server.js';

interface FleetSessionRow {
  id: string;
  agent_id: string;
  task: string;
  status: string;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
}

/**
 * Minimal Neon tagged-template stand-in that stores coordination_sessions
 * rows so dual-write from daemon A is visible to fleet SELECT from daemon B.
 */
function createSharedNeonStore(): {
  mock: (strings: TemplateStringsArray | readonly string[], ...values: unknown[]) => Promise<unknown>;
  sessions: Map<string, FleetSessionRow>;
} {
  const sessions = new Map<string, FleetSessionRow>();

  const mock = (strings: TemplateStringsArray | readonly string[], ...values: unknown[]) => {
    const sql = Array.from(strings).join(' ').replace(/\s+/g, ' ').trim().toUpperCase();

    if (sql.includes('INSERT INTO COORDINATION_AGENTS')) {
      return Promise.resolve([]);
    }

    if (sql.includes('INSERT INTO COORDINATION_SESSIONS')) {
      // VALUES (${agentId}, ${agentId}, ${task}, 'active', ${pid}, NOW())
      const agentId = String(values[0] ?? '');
      const task = values[2] == null ? '' : String(values[2]);
      const pid = typeof values[3] === 'number' ? values[3] : null;
      const row: FleetSessionRow = {
        id: agentId,
        agent_id: agentId,
        task,
        status: 'active',
        pid,
        started_at: new Date().toISOString(),
        ended_at: null,
      };
      sessions.set(agentId, row);
      return Promise.resolve([]);
    }

    if (sql.includes('UPDATE COORDINATION_SESSIONS') && sql.includes('ENDED_AT')) {
      const sessionId = String(values[values.length - 1] ?? values[0] ?? '');
      const existing = sessions.get(sessionId);
      if (existing) {
        sessions.set(sessionId, {
          ...existing,
          status: 'ended',
          ended_at: new Date().toISOString(),
        });
      }
      return Promise.resolve([]);
    }

    if (sql.includes('UPDATE COORDINATION_SESSIONS') && sql.includes('SET TASK')) {
      const task = String(values[0] ?? '');
      const sessionId = String(values[1] ?? '');
      const existing = sessions.get(sessionId);
      if (existing) {
        sessions.set(sessionId, { ...existing, task });
      }
      return Promise.resolve([]);
    }

    if (sql.includes('FROM COORDINATION_SESSIONS') && sql.includes('ENDED_AT IS NULL')) {
      const active = [...sessions.values()].filter((r) => r.ended_at === null);
      active.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
      return Promise.resolve(active);
    }

    // Other dual-writes (mail/files/tasks/events) unused in this suite.
    return Promise.resolve([]);
  };

  return {
    // biome-ignore lint/suspicious/noExplicitAny: NeonQueryFunction tagged-template shape
    mock: mock as any,
    sessions,
  };
}

function rpc(socketPath: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socketPath);
    let buf = '';
    const req = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`;
    sock.on('connect', () => sock.write(req));
    sock.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      sock.end();
      try {
        const resp = JSON.parse(line) as {
          result?: unknown;
          error?: { code: number; message: string };
        };
        if (resp.error) reject(new Error(`${resp.error.code}: ${resp.error.message}`));
        else resolve(resp.result);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    sock.on('error', reject);
    sock.setTimeout(10_000, () => {
      sock.destroy();
      reject(new Error(`RPC timeout: ${method}`));
    });
  });
}

async function bootDaemon(label: string): Promise<{
  dataDir: string;
  socketPath: string;
  close: () => Promise<void>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), `revdev-fleet-${label}-`));
  const socketPath = join(dataDir, 'harness.sock');
  const anchor = join(dataDir, 'trusted-client-fingerprint');
  await writeFile(anchor, '');
  const d = await startDaemon({
    socketPath,
    dataDir,
    pruneIntervalMs: 0,
    trustedClientFingerprintPath: anchor,
    trustedAnchorRequireRootOwned: false,
  });
  return { dataDir, socketPath, close: d.close };
}

describe('GAP-154: two-daemon fleet visibility (shared Neon mock)', () => {
  let closeA: (() => Promise<void>) | undefined;
  let closeB: (() => Promise<void>) | undefined;
  let dataDirA: string;
  let dataDirB: string;
  let socketA: string;
  let socketB: string;
  let originalLicenseKey: string | undefined;
  let store: ReturnType<typeof createSharedNeonStore>;

  beforeAll(async () => {
    const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
    originalLicenseKey = process.env.REVEALUI_LICENSE_KEY;
    setTestLicenseEnv(generateTestLicense('enterprise'));

    store = createSharedNeonStore();

    // Boot first: startDaemon → initNeonSync() clears any prior test client when
    // POSTGRES_URL is unset. Inject the shared mock only after both listen.
    const a = await bootDaemon('a');
    const b = await bootDaemon('b');
    dataDirA = a.dataDir;
    dataDirB = b.dataDir;
    socketA = a.socketPath;
    socketB = b.socketPath;
    closeA = a.close;
    closeB = b.close;

    setNeonClientForTesting(store.mock);
  });

  afterAll(async () => {
    await closeA?.();
    await closeB?.();
    await rm(dataDirA, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataDirB, { recursive: true, force: true }).catch(() => undefined);
    _resetForTesting();
    if (originalLicenseKey === undefined) {
      delete process.env.REVEALUI_LICENSE_KEY;
    } else {
      process.env.REVEALUI_LICENSE_KEY = originalLicenseKey;
    }
    const { clearTestLicenseEnv } = await import('./test-license-helper.js');
    clearTestLicenseEnv();
  });

  it("B's session.list({scope:'fleet'}) sees a session registered on A", async () => {
    const reg = (await rpc(socketA, 'session.register', {
      agentId: 'fleet-agent-a',
      agentName: 'fleet-agent-a',
      backend: 'test',
      env: 'host-a',
      task: 'work-on-a',
    })) as { sessionId: string };

    expect(reg.sessionId).toBe('fleet-agent-a');
    expect(store.sessions.has('fleet-agent-a')).toBe(true);

    // Local list on B must NOT invent A's row (PGlite is per-daemon).
    const localB = (await rpc(socketB, 'session.list')) as {
      sessions: Array<{ id: string }>;
      scope: string;
    };
    expect(localB.scope).toBe('local');
    expect(localB.sessions.some((s) => s.id === 'fleet-agent-a')).toBe(false);

    const fleetB = (await rpc(socketB, 'session.list', { scope: 'fleet' })) as {
      sessions: Array<{ id: string; task: string }>;
      scope: string;
      neonSyncActive: boolean;
    };

    expect(fleetB.scope).toBe('fleet');
    expect(fleetB.neonSyncActive).toBe(true);
    const seen = fleetB.sessions.find((s) => s.id === 'fleet-agent-a');
    expect(seen).toBeDefined();
    expect(seen?.task).toBe('work-on-a');
  });

  it('fleet list includes sessions from both daemons after B also registers', async () => {
    await rpc(socketB, 'session.register', {
      agentId: 'fleet-agent-b',
      agentName: 'fleet-agent-b',
      backend: 'test',
      env: 'host-b',
      task: 'work-on-b',
    });

    const fleetA = (await rpc(socketA, 'session.list', { scope: 'fleet' })) as {
      sessions: Array<{ id: string }>;
    };
    const ids = new Set(fleetA.sessions.map((s) => s.id));
    expect(ids.has('fleet-agent-a')).toBe(true);
    expect(ids.has('fleet-agent-b')).toBe(true);
  });

  it('harness.health on both daemons reports neonSyncActive', async () => {
    const ha = (await rpc(socketA, 'harness.health')) as { neonSyncActive: boolean };
    const hb = (await rpc(socketB, 'harness.health')) as { neonSyncActive: boolean };
    expect(ha.neonSyncActive).toBe(true);
    expect(hb.neonSyncActive).toBe(true);
  });
});
