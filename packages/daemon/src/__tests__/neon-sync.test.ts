/**
 * GAP-154 Phase 2 — daemon → Neon sync wiring tests.
 *
 * Uses `setNeonClientForTesting()` to inject a mock that records SQL calls,
 * so we can verify dual-write happens without needing a real Neon instance.
 * The full 2-daemon cross-machine test (which DOES need a Neon URL) lives
 * in `neon-sync.integration.test.ts` and is skipped by default.
 *
 * @vitest-environment node
 */
import { vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { _resetForTesting, setNeonClientForTesting } from '../neon.js';
import { startDaemon } from '../server.js';

function rpc(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
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
        const resp = JSON.parse(line);
        if (resp.error) reject(new Error(`${resp.error.code}: ${resp.error.message}`));
        else resolve(resp.result);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    sock.on('error', reject);
    sock.setTimeout(5000, () => {
      sock.destroy();
      reject(new Error(`RPC timeout: ${method}`));
    });
  });
}

interface RecordedCall {
  strings: readonly string[];
  values: unknown[];
}

let dataDir: string;
let socketPath: string;
let close: () => Promise<void>;
let originalLicenseKey: string | undefined;
let recordedCalls: RecordedCall[];
let nextResult: unknown[];

beforeAll(async () => {
  const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
  originalLicenseKey = process.env.REVEALUI_LICENSE_KEY;
  setTestLicenseEnv(generateTestLicense('enterprise'));
  dataDir = await mkdtemp(join(tmpdir(), 'revdev-neon-'));
  socketPath = join(dataDir, 'harness.sock');
  // Disable periodic prune so it doesn't touch the test DB unexpectedly.
  const d = await startDaemon({ socketPath, dataDir, pruneIntervalMs: 0 });
  close = d.close;
});

afterAll(async () => {
  await close?.();
  await rm(dataDir, { recursive: true, force: true });
  _resetForTesting();
  if (originalLicenseKey === undefined) {
    delete process.env.REVEALUI_LICENSE_KEY;
  } else {
    process.env.REVEALUI_LICENSE_KEY = originalLicenseKey;
  }
  const { clearTestLicenseEnv } = await import('./test-license-helper.js');
  clearTestLicenseEnv();
});

beforeEach(() => {
  recordedCalls = [];
  nextResult = [];
  // The daemon's @neondatabase/serverless client is invoked as a tagged
  // template literal: client`SELECT ...`. The mock function below mimics
  // that signature, recording each call and returning a Promise of the
  // pre-staged result (default: empty array).
  const mock = ((strings: readonly string[], ...values: unknown[]) => {
    recordedCalls.push({ strings, values });
    return Promise.resolve(nextResult);
    // biome-ignore lint/suspicious/noExplicitAny: matches NeonQueryFunction shape
  }) as any;
  setNeonClientForTesting(mock);
});

describe('GAP-154: daemon → Neon dual-write wiring', () => {
  it('session.register triggers upsert on coordination_agents + coordination_sessions', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'sync-test-1',
      agentName: 'sync-test-1',
      backend: 'test',
      task: '/tmp/sync-test',
    });

    // Two SQL calls expected: one for coordination_agents, one for
    // coordination_sessions. The order matters (agent FK referenced by
    // session row).
    expect(recordedCalls.length).toBe(2);

    const [agentRecord, sessionRecord] = recordedCalls;
    const agentCall = agentRecord?.strings.join('') ?? '';
    expect(agentCall).toMatch(/INSERT\s+INTO\s+coordination_agents/i);
    expect(agentCall).toMatch(/ON\s+CONFLICT/i);
    expect(agentRecord?.values).toContain('sync-test-1');

    const sessionCall = sessionRecord?.strings.join('') ?? '';
    expect(sessionCall).toMatch(/INSERT\s+INTO\s+coordination_sessions/i);
    expect(sessionCall).toMatch(/'active'/i); // status defaults to active
    expect(sessionRecord?.values).toContain('sync-test-1');
  });

  it('session.update with task triggers UPDATE on coordination_sessions', async () => {
    // Pre-register so we have a session to update.
    await rpc(socketPath, 'session.register', {
      agentId: 'sync-test-2',
      agentName: 'sync-test-2',
      backend: 'test',
    });
    recordedCalls = []; // discard register's writes; only assert on update

    await rpc(socketPath, 'session.update', {
      actorAgentId: 'sync-test-2',
      sessionId: 'sync-test-2',
      task: 'updated task description',
    });

    expect(recordedCalls.length).toBe(1);
    const [updateRecord] = recordedCalls;
    const updateCall = updateRecord?.strings.join('') ?? '';
    expect(updateCall).toMatch(/UPDATE\s+coordination_sessions/i);
    expect(updateCall).toMatch(/SET\s+task/i);
    expect(updateRecord?.values).toEqual(['updated task description', 'sync-test-2']);
  });

  it('session.update without task does NOT call Neon (nothing to mirror)', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'sync-test-3',
      agentName: 'sync-test-3',
      backend: 'test',
    });
    recordedCalls = [];

    await rpc(socketPath, 'session.update', {
      actorAgentId: 'sync-test-3',
      sessionId: 'sync-test-3',
      files: 'a.ts,b.ts', // files-only update, no task
    });

    expect(recordedCalls.length).toBe(0);
  });

  it('session.end triggers UPDATE setting ended_at + status=ended + summary in metadata', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'sync-test-4',
      agentName: 'sync-test-4',
      backend: 'test',
    });
    recordedCalls = [];

    await rpc(socketPath, 'session.end', {
      actorAgentId: 'sync-test-4',
      sessionId: 'sync-test-4',
      summary: 'all done',
    });

    expect(recordedCalls.length).toBe(1);
    const [endRecord] = recordedCalls;
    const endCall = endRecord?.strings.join('') ?? '';
    expect(endCall).toMatch(/UPDATE\s+coordination_sessions/i);
    expect(endCall).toMatch(/ended_at\s*=\s*NOW\(\)/i);
    expect(endCall).toMatch(/'ended'/i);
    expect(endCall).toMatch(/metadata/i);
    expect(endRecord?.values).toContain('sync-test-4');
  });

  it("session.list with scope='fleet' queries Neon, default scope queries PGlite", async () => {
    nextResult = [
      {
        id: 'remote-agent-on-other-host',
        agent_id: 'remote-agent-on-other-host',
        task: 'remote work',
        status: 'active',
        pid: null,
        started_at: '2026-04-28T00:00:00.000Z',
        ended_at: null,
      },
    ];

    const fleet = (await rpc(socketPath, 'session.list', { scope: 'fleet' })) as {
      sessions: Array<{ id: string }>;
      scope: string;
      neonSyncActive: boolean;
    };

    expect(fleet.scope).toBe('fleet');
    expect(fleet.neonSyncActive).toBe(true); // mock is set
    expect(fleet.sessions.length).toBe(1);
    expect(fleet.sessions[0]?.id).toBe('remote-agent-on-other-host');
    expect(recordedCalls.length).toBe(1);
    const [fleetRecord] = recordedCalls;
    expect(fleetRecord?.strings.join('') ?? '').toMatch(/FROM\s+coordination_sessions/i);

    // Default scope: should NOT touch Neon.
    recordedCalls = [];
    const local = (await rpc(socketPath, 'session.list')) as {
      sessions: unknown[];
      scope: string;
    };
    expect(local.scope).toBe('local');
    expect(recordedCalls.length).toBe(0);
  });

  it('Neon sync failures do not fail the RPC (best-effort dual-write)', async () => {
    // Replace the mock with one that throws.
    const failingMock = ((_strings: readonly string[], ..._values: unknown[]) => {
      return Promise.reject(new Error('simulated Neon outage'));
      // biome-ignore lint/suspicious/noExplicitAny: matches NeonQueryFunction shape
    }) as any;
    setNeonClientForTesting(failingMock);

    // session.register should still succeed because PGlite write happens
    // first and the Neon error is logged + swallowed.
    const result = (await rpc(socketPath, 'session.register', {
      agentId: 'sync-test-failure',
      agentName: 'sync-test-failure',
      backend: 'test',
    })) as { sessionId: string };

    expect(result.sessionId).toBe('sync-test-failure');
  });

  it('harness.health surfaces neonSyncActive flag', async () => {
    const health = (await rpc(socketPath, 'harness.health')) as {
      status: string;
      neonSyncActive: boolean;
    };
    expect(health.status).toBe('healthy');
    // Mock is set in beforeEach, so neonSyncActive should be true.
    expect(health.neonSyncActive).toBe(true);
  });
});
