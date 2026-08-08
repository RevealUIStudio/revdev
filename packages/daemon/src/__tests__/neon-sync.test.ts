/**
 * GAP-154 Phase 2 — daemon → Neon sync wiring tests.
 *
 * Uses `setNeonClientForTesting()` to inject a mock that records SQL calls,
 * so we can verify dual-write happens without needing a real Neon instance.
 * Two-daemon A→shared-Neon→B fleet visibility (process-local mock, no network
 * Neon) lives in `neon-fleet-two-daemon.test.ts`. Live multi-host + real
 * POSTGRES_URL dogfood remains operator residual.
 *
 * @vitest-environment node
 */
import { vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDid } from '@revdev/protocol/did';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  computeFingerprint,
  generateAgentKeypair,
  generateNonce,
  hashParams,
  serializeEnvelope,
  signEnvelope,
} from '../agent-identity-crypto.js';
import { _resetForTesting, setNeonClientForTesting, sweepExpiredFileClaims } from '../neon.js';
import { startDaemon } from '../server.js';

/**
 * `session.end` is signature-required (it evicts roots and kills PTYs), so the
 * test that exercises its Neon dual-write has to sign like a real client.
 */
function makeSigner(agentId: string) {
  const kp = generateAgentKeypair();
  const fingerprint = computeFingerprint(kp.publicKeyRaw);
  const did = formatDid(agentId, fingerprint);
  const sign = (method: string, params: Record<string, unknown>): string =>
    serializeEnvelope(
      signEnvelope(
        {
          did,
          kid: fingerprint,
          nonce: generateNonce(),
          ts: Math.floor(Date.now() / 1000),
          method,
          paramsHash: hashParams(method, params),
        },
        kp.privateKeyPem,
      ),
    );
  return { agentId, fingerprint, publicKeyPem: kp.publicKeyPem, sign };
}

function rpc(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  signature?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socketPath);
    let buf = '';
    const frame: Record<string, unknown> = { jsonrpc: '2.0', id: 1, method, params };
    if (signature) frame['x-revdev-signature'] = signature;
    const req = `${JSON.stringify(frame)}\n`;
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

/** Client-owned identity used by the signature-required session.end test. */
const ender = makeSigner('sync-test-4');

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
  // Provision the signer's fingerprint so it can enroll a client-owned key.
  const anchor = join(dataDir, 'trusted-client-fingerprint');
  await writeFile(anchor, `${ender.agentId}:${ender.fingerprint}\n`);
  // Disable periodic prune so it doesn't touch the test DB unexpectedly.
  const d = await startDaemon({
    socketPath,
    dataDir,
    pruneIntervalMs: 0,
    trustedClientFingerprintPath: anchor,
    trustedAnchorRequireRootOwned: false,
  });
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
    // Register the client-owned key so the daemon can verify the signature.
    await rpc(socketPath, 'session.register', {
      agentId: ender.agentId,
      agentName: ender.agentId,
      backend: 'test',
      publicKeyPem: ender.publicKeyPem,
    });
    recordedCalls = [];

    // session.end is signature-required and self-scopes to the signer, so no
    // sessionId is passed: the signer IS the target.
    const endParams = { summary: 'all done' };
    await rpc(socketPath, 'session.end', endParams, ender.sign('session.end', endParams));

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

// ---------------------------------------------------------------------------
// GAP-154 Phase 3 — mail / files / tasks / events sync wiring.
// Same mock pattern as Phase 2: inject a recording client, exercise the
// RPC, assert the right SQL fired with the right values.
// ---------------------------------------------------------------------------

describe('GAP-154 Phase 3: mail.* dual-write', () => {
  it('mail.send mirrors to coordination_mail with shared UUID (GAP-176)', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'mail-sender',
      agentName: 'mail-sender',
      backend: 'test',
    });
    recordedCalls = [];
    const sent = (await rpc(socketPath, 'mail.send', {
      actorAgentId: 'mail-sender',
      to: 'mail-recipient',
      subject: 'phase 3 hi',
      body: 'hello from a mock',
    })) as { id: string };
    expect(typeof sent.id).toBe('string');
    expect(sent.id.length).toBeGreaterThan(10);
    expect(recordedCalls.length).toBe(1);
    const [send] = recordedCalls;
    const sql = send?.strings.join('') ?? '';
    expect(sql).toMatch(/INSERT\s+INTO\s+coordination_mail/i);
    expect(sql).toMatch(/\bid\b/i);
    // values: id, from, to, subject, body
    expect(send?.values[0]).toBe(sent.id);
    expect(send?.values).toContain('mail-sender');
    expect(send?.values).toContain('mail-recipient');
    expect(send?.values).toContain('phase 3 hi');
    expect(send?.values).toContain('hello from a mock');
  });

  it('mail.broadcast fans out one Neon write per recipient', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'broadcaster',
      agentName: 'broadcaster',
      backend: 'test',
    });
    await rpc(socketPath, 'session.register', {
      agentId: 'recipient-a',
      agentName: 'recipient-a',
      backend: 'test',
    });
    await rpc(socketPath, 'session.register', {
      agentId: 'recipient-b',
      agentName: 'recipient-b',
      backend: 'test',
    });
    recordedCalls = [];
    await rpc(socketPath, 'mail.broadcast', {
      actorAgentId: 'broadcaster',
      subject: 'broadcast subject',
      body: 'broadcast body',
    });
    const inserts = recordedCalls.filter((c) =>
      /INSERT\s+INTO\s+coordination_mail/i.test(c.strings.join('')),
    );
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    const allValues = inserts.flatMap((c) => c.values);
    expect(allValues).toContain('recipient-a');
    expect(allValues).toContain('recipient-b');
    // Each INSERT carries its own UUID as first value.
    for (const ins of inserts) {
      expect(typeof ins.values[0]).toBe('string');
      expect(String(ins.values[0]).length).toBeGreaterThan(10);
    }
    // toAgent is values[2] after id, fromAgent (id, from, to, subject, body)
    const tos = inserts.map((c) => c.values[2]);
    expect(tos).not.toContain('broadcaster');
  });

  it('mail.markRead dual-writes by UUID only — not subject/body (GAP-176)', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'reader',
      agentName: 'reader',
      backend: 'test',
    });
    await rpc(socketPath, 'session.register', {
      agentId: 'sender',
      agentName: 'sender',
      backend: 'test',
    });
    // Two identical subject/body messages — heuristic would mark both; UUID marks one.
    const a = (await rpc(socketPath, 'mail.send', {
      actorAgentId: 'sender',
      to: 'reader',
      subject: 'same subject',
      body: 'same body',
    })) as { id: string };
    const b = (await rpc(socketPath, 'mail.send', {
      actorAgentId: 'sender',
      to: 'reader',
      subject: 'same subject',
      body: 'same body',
    })) as { id: string };
    expect(a.id).not.toBe(b.id);
    recordedCalls = [];

    await rpc(socketPath, 'mail.markRead', {
      actorAgentId: 'reader',
      messageIds: [a.id],
    });
    const updates = recordedCalls.filter((c) =>
      /UPDATE\s+coordination_mail/i.test(c.strings.join('')),
    );
    expect(updates.length).toBe(1);
    const update = updates[0];
    const sql = update?.strings.join('') ?? '';
    expect(sql).toMatch(/id\s*=\s*ANY/i);
    expect(sql).not.toMatch(/subject\s*=/i);
    expect(sql).not.toMatch(/body\s*=/i);
    expect(update?.values).toContain('reader');
    // ids array is the second bind
    expect(update?.values).toEqual(expect.arrayContaining(['reader', [a.id]]));
    expect(update?.values.flat()).not.toContain(b.id);
  });
});

describe('GAP-154 Phase 3: files.* dual-write', () => {
  it('files.reserve mirrors successful claims to coordination_file_claims', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'file-reserver',
      agentName: 'file-reserver',
      backend: 'test',
    });
    recordedCalls = [];
    const before = Date.now();
    await rpc(socketPath, 'files.reserve', {
      actorAgentId: 'file-reserver',
      paths: ['src/a.ts', 'src/b.ts'],
      reason: 'editing',
      ttlSeconds: 600,
    });
    const inserts = recordedCalls.filter((c) =>
      /INSERT\s+INTO\s+coordination_file_claims/i.test(c.strings.join('')),
    );
    expect(inserts.length).toBe(2);
    const allValues = inserts.flatMap((c) => c.values);
    expect(allValues).toContain('src/a.ts');
    expect(allValues).toContain('src/b.ts');
    expect(allValues).toContain('file-reserver');
    // GAP-175: each INSERT carries expires_at (~ now + ttlSeconds)
    const sql = inserts[0]?.strings.join('') ?? '';
    expect(sql).toMatch(/expires_at/i);
    const isoExpiry = allValues.find(
      (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v),
    ) as string | undefined;
    expect(isoExpiry).toBeTruthy();
    const expMs = Date.parse(isoExpiry ?? '');
    expect(expMs).toBeGreaterThanOrEqual(before + 590_000);
    expect(expMs).toBeLessThanOrEqual(Date.now() + 610_000);
  });

  it('files.release with paths DELETEs scoped to (sessionId, paths)', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'file-releaser',
      agentName: 'file-releaser',
      backend: 'test',
    });
    await rpc(socketPath, 'files.reserve', {
      actorAgentId: 'file-releaser',
      paths: ['src/c.ts'],
    });
    recordedCalls = [];
    await rpc(socketPath, 'files.release', {
      actorAgentId: 'file-releaser',
      paths: ['src/c.ts'],
    });
    const deletes = recordedCalls.filter((c) =>
      /DELETE\s+FROM\s+coordination_file_claims/i.test(c.strings.join('')),
    );
    expect(deletes.length).toBe(1);
    const sql = deletes[0]?.strings.join('') ?? '';
    expect(sql).toMatch(/file_path\s*=\s*ANY/i);
    expect(deletes[0]?.values).toContain('file-releaser');
  });

  it('files.release without paths DELETEs all rows for the session', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'file-releaser-all',
      agentName: 'file-releaser-all',
      backend: 'test',
    });
    await rpc(socketPath, 'files.reserve', {
      actorAgentId: 'file-releaser-all',
      paths: ['src/d.ts'],
    });
    recordedCalls = [];
    await rpc(socketPath, 'files.release', {
      actorAgentId: 'file-releaser-all',
      // no paths — release all
    });
    const deletes = recordedCalls.filter((c) =>
      /DELETE\s+FROM\s+coordination_file_claims/i.test(c.strings.join('')),
    );
    expect(deletes.length).toBe(1);
    const sql = deletes[0]?.strings.join('') ?? '';
    expect(sql).not.toMatch(/file_path/i); // no path filter
    expect(deletes[0]?.values).toEqual(['file-releaser-all']);
  });

  it('sweepExpiredFileClaims DELETEs Neon rows past expires_at (GAP-175)', async () => {
    recordedCalls = [];
    nextResult = [{ file_path: 'src/expired.ts' }];
    const r = await sweepExpiredFileClaims();
    expect(r.deleted).toBe(1);
    const deletes = recordedCalls.filter((c) =>
      /DELETE\s+FROM\s+coordination_file_claims/i.test(c.strings.join('')),
    );
    expect(deletes.length).toBe(1);
    const sql = deletes[0]?.strings.join('') ?? '';
    expect(sql).toMatch(/expires_at\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/expires_at\s*<\s*NOW\(\)/i);
  });
});

describe('GAP-154 Phase 3: tasks.* dual-write', () => {
  it('tasks.create mirrors to coordination_work_items with title/description split', async () => {
    recordedCalls = [];
    await rpc(socketPath, 'tasks.create', {
      actorAgentId: 'creator',
      taskId: 'task-1',
      title: 'investigate',
      description: 'check the foo subsystem',
      priority: 'high',
    });
    const inserts = recordedCalls.filter((c) =>
      /INSERT\s+INTO\s+coordination_work_items/i.test(c.strings.join('')),
    );
    expect(inserts.length).toBe(1);
    expect(inserts[0]?.values).toContain('task-1');
    expect(inserts[0]?.values).toContain('investigate'); // title
    expect(inserts[0]?.values).toContain('check the foo subsystem'); // description
    expect(inserts[0]?.values).toContain(1); // priority='high' → 1
  });

  it('tasks.claim mirrors UPDATE to coordination_work_items', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'claimer',
      agentName: 'claimer',
      backend: 'test',
    });
    await rpc(socketPath, 'tasks.create', {
      actorAgentId: 'creator',
      taskId: 'task-2',
      title: 'thing',
    });
    recordedCalls = [];
    await rpc(socketPath, 'tasks.claim', {
      actorAgentId: 'claimer',
      taskId: 'task-2',
    });
    const updates = recordedCalls.filter((c) =>
      /UPDATE\s+coordination_work_items/i.test(c.strings.join('')),
    );
    expect(updates.length).toBe(1);
    const sql = updates[0]?.strings.join('') ?? '';
    expect(sql).toMatch(/'claimed'/);
    expect(updates[0]?.values).toContain('claimer');
    expect(updates[0]?.values).toContain('task-2');
  });

  it("tasks.complete translates daemon 'completed' → Neon 'done'", async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'completer',
      agentName: 'completer',
      backend: 'test',
    });
    await rpc(socketPath, 'tasks.create', {
      actorAgentId: 'creator',
      taskId: 'task-3',
      title: 'thing',
    });
    await rpc(socketPath, 'tasks.claim', {
      actorAgentId: 'completer',
      taskId: 'task-3',
    });
    recordedCalls = [];
    await rpc(socketPath, 'tasks.complete', {
      actorAgentId: 'completer',
      taskId: 'task-3',
      summary: 'fixed it',
    });
    const updates = recordedCalls.filter((c) =>
      /UPDATE\s+coordination_work_items/i.test(c.strings.join('')),
    );
    expect(updates.length).toBe(1);
    const sql = updates[0]?.strings.join('') ?? '';
    expect(sql).toMatch(/'done'/);
    expect(sql).toMatch(/completed_at\s*=\s*NOW\(\)/i);
    // Summary appended via the COALESCE-||-' — '-||-summary pattern.
    expect(updates[0]?.values).toContain('fixed it');
  });

  it('tasks.release mirrors UPDATE setting status=open + owner_agent=NULL', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'releaser',
      agentName: 'releaser',
      backend: 'test',
    });
    await rpc(socketPath, 'tasks.create', {
      actorAgentId: 'creator',
      taskId: 'task-4',
      title: 'thing',
    });
    await rpc(socketPath, 'tasks.claim', {
      actorAgentId: 'releaser',
      taskId: 'task-4',
    });
    recordedCalls = [];
    await rpc(socketPath, 'tasks.release', {
      actorAgentId: 'releaser',
      taskId: 'task-4',
    });
    const updates = recordedCalls.filter((c) =>
      /UPDATE\s+coordination_work_items/i.test(c.strings.join('')),
    );
    expect(updates.length).toBe(1);
    const sql = updates[0]?.strings.join('') ?? '';
    expect(sql).toMatch(/'open'/);
    expect(sql).toMatch(/owner_agent\s*=\s*NULL/i);
    expect(updates[0]?.values).toContain('task-4');
    expect(updates[0]?.values).toContain('releaser');
  });
});

describe('GAP-154 Phase 3: events.log dual-write', () => {
  it('events.log mirrors to coordination_events with payload as JSONB', async () => {
    recordedCalls = [];
    await rpc(socketPath, 'events.log', {
      actorAgentId: 'event-source',
      // The handler reads params.agentId as the event source (independent
      // of dispatch identity). Pass it for assertion clarity even though
      // ctx.agentId would also work as a fallback.
      agentId: 'event-source',
      eventType: 'tool.invoke',
      payload: { tool: 'Read', durationMs: 42 },
    });
    const inserts = recordedCalls.filter((c) =>
      /INSERT\s+INTO\s+coordination_events/i.test(c.strings.join('')),
    );
    expect(inserts.length).toBe(1);
    expect(inserts[0]?.values).toContain('event-source');
    expect(inserts[0]?.values).toContain('tool.invoke');
    // 'info' is inline SQL in syncEventLog (not a parameter) — assert on
    // the strings, not values.
    expect(inserts[0]?.strings.join('')).toMatch(/'info'/);
    // payload is JSON-stringified before binding.
    const payloadValue = inserts[0]?.values.find(
      (v) => typeof v === 'string' && v.includes('"tool"'),
    );
    expect(payloadValue).toBeDefined();
  });
});
