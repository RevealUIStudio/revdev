/**
 * Two-agent coordination integration tests.
 *
 * Spins up a real daemon on a throwaway socket with an isolated temp data dir,
 * connects two sockets as distinct agents, and exercises mail routing,
 * file-reservation conflict detection, and task ownership enforcement.
 *
 * Covers §5.15 exit criteria: "two or more agents coordinate via the daemon
 * without human relay," proven at the RPC layer.
 *
 * @vitest-environment node
 */
// Daemon startup can take >10s in CI (key generation + socket bind).
import { vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon } from '../server.js';

// ---------------------------------------------------------------------------
// Test harness: one JSON-RPC call per client (fresh socket each time).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let dataDir: string;
let socketPath: string;
let close: () => Promise<void>;
let originalLicenseKey: string | undefined;

beforeAll(async () => {
  // Coordination RPCs are license-gated (Pro+). Tests generate a real
  // Ed25519-signed v2 key so the guard lets calls through.
  const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
  originalLicenseKey = process.env.REVEALUI_LICENSE_KEY;
  setTestLicenseEnv(generateTestLicense('enterprise'));
  dataDir = await mkdtemp(join(tmpdir(), 'revdev-coord-'));
  socketPath = join(dataDir, 'harness.sock');
  const d = await startDaemon({ socketPath, dataDir });
  close = d.close;
});

afterAll(async () => {
  await close?.();
  await rm(dataDir, { recursive: true, force: true });
  if (originalLicenseKey === undefined) {
    delete process.env.REVEALUI_LICENSE_KEY;
  } else {
    process.env.REVEALUI_LICENSE_KEY = originalLicenseKey;
  }
  const { clearTestLicenseEnv } = await import('./test-license-helper.js');
  clearTestLicenseEnv();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('socket hardening', () => {
  it('socket file is mode 0600 (restricted to owning UID)', async () => {
    const s = await stat(socketPath);
    // Mask to the permission bits; ignore the type bits (0o140000 = socket).
    expect(s.mode & 0o777).toBe(0o600);
  });
});

describe('two-agent coordination', () => {
  let alice: string;
  let bob: string;

  it('registers two distinct agent sessions', async () => {
    const aResult = (await rpc(socketPath, 'session.register', {
      agentName: 'alice',
      workDir: '/tmp/alice',
      backend: 'test',
    })) as { sessionId: string };
    const bResult = (await rpc(socketPath, 'session.register', {
      agentName: 'bob',
      workDir: '/tmp/bob',
      backend: 'test',
    })) as { sessionId: string };

    expect(aResult.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bResult.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(aResult.sessionId).not.toBe(bResult.sessionId);
    alice = aResult.sessionId;
    bob = bResult.sessionId;
  });

  it('routes mail from alice to bob (not to alice)', async () => {
    await rpc(socketPath, 'mail.send', {
      actorAgentId: alice,
      to: bob,
      subject: 'hello',
      body: 'from alice',
    });

    const aliceInbox = (await rpc(socketPath, 'mail.inbox', {
      actorAgentId: alice,
      agentId: alice,
    })) as { messages: Array<{ subject: string; from_agent: string }> };
    const bobInbox = (await rpc(socketPath, 'mail.inbox', {
      actorAgentId: bob,
      agentId: bob,
    })) as { messages: Array<{ subject: string; from_agent: string; id: number }> };

    expect(aliceInbox.messages).toHaveLength(0);
    expect(bobInbox.messages).toHaveLength(1);
    expect(bobInbox.messages[0]?.subject).toBe('hello');
    expect(bobInbox.messages[0]?.from_agent).toBe(alice);
  });

  it('marks messages read by id (parameterized int[])', async () => {
    const inbox = (await rpc(socketPath, 'mail.inbox', {
      actorAgentId: bob,
      agentId: bob,
    })) as { messages: Array<{ id: number }> };
    const ids = inbox.messages.map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);

    const mark = (await rpc(socketPath, 'mail.markRead', {
      actorAgentId: bob,
      messageIds: ids,
    })) as { marked: number };
    expect(mark.marked).toBeGreaterThan(0);

    const after = (await rpc(socketPath, 'mail.inbox', {
      actorAgentId: bob,
      agentId: bob,
    })) as { messages: unknown[] };
    expect(after.messages).toHaveLength(0);
  });

  it('detects file reservation conflict between agents', async () => {
    const path = '/tmp/shared/file.ts';
    const aRes = (await rpc(socketPath, 'files.reserve', {
      actorAgentId: alice,
      paths: [path],
      reason: 'edit',
      ttlSeconds: 60,
    })) as { success: boolean; reserved: string[]; conflicts: unknown[] };
    expect(aRes.success).toBe(true);
    expect(aRes.reserved).toContain(path);

    const bRes = (await rpc(socketPath, 'files.reserve', {
      actorAgentId: bob,
      paths: [path],
      reason: 'edit',
      ttlSeconds: 60,
    })) as {
      success: boolean;
      reserved: string[];
      conflicts: Array<{ path: string; holder: string }>;
    };
    expect(bRes.success).toBe(false);
    expect(bRes.conflicts).toHaveLength(1);
    expect(bRes.conflicts[0]?.holder).toBe(alice);
  });

  it('check surfaces reservation to any agent', async () => {
    const check = (await rpc(socketPath, 'files.check', {
      actorAgentId: bob,
      paths: ['/tmp/shared/file.ts'],
    })) as { reservations: Array<{ agent_id: string }> };
    expect(check.reservations[0]?.agent_id).toBe(alice);
  });

  it('only the claiming agent can complete a task', async () => {
    const created = (await rpc(socketPath, 'tasks.create', {
      actorAgentId: alice,
      title: 'ship feature',
    })) as { taskId: string };
    const taskId = created.taskId;

    const claim = (await rpc(socketPath, 'tasks.claim', {
      actorAgentId: alice,
      taskId,
    })) as { success: boolean; owner: string };
    expect(claim.success).toBe(true);
    expect(claim.owner).toBe(alice);

    // Bob attempts to complete alice's task — should no-op.
    const bobComplete = (await rpc(socketPath, 'tasks.complete', {
      actorAgentId: bob,
      taskId,
    })) as { ok: boolean };
    expect(bobComplete.ok).toBe(false);

    // Alice can complete it.
    const aliceComplete = (await rpc(socketPath, 'tasks.complete', {
      actorAgentId: alice,
      taskId,
    })) as { ok: boolean };
    expect(aliceComplete.ok).toBe(true);
  });

  it('bob cannot claim a task alice already owns', async () => {
    const created = (await rpc(socketPath, 'tasks.create', {
      actorAgentId: alice,
      title: 'conflicting work',
    })) as { taskId: string };
    await rpc(socketPath, 'tasks.claim', {
      actorAgentId: alice,
      taskId: created.taskId,
    });
    const bobClaim = (await rpc(socketPath, 'tasks.claim', {
      actorAgentId: bob,
      taskId: created.taskId,
    })) as { success: boolean; owner: string | null };
    expect(bobClaim.success).toBe(false);
    expect(bobClaim.owner).toBe(alice);
  });

  it('rejects coordination calls without any identity', async () => {
    await expect(
      rpc(socketPath, 'mail.send', { to: bob, subject: 'x', body: 'y' }),
    ).rejects.toThrow(/Not registered/);
  });

  it('accepts stable agentId (upsert) for hook-style registration', async () => {
    // First registration creates the row.
    const r1 = (await rpc(socketPath, 'session.register', {
      agentId: 'conductor',
      agentName: 'conductor',
      workDir: '/tmp/conductor',
      backend: 'claude-code',
    })) as { sessionId: string; session: { id: string } };
    expect(r1.sessionId).toBe('conductor');
    expect(r1.session.id).toBe('conductor');

    // Second registration with same id is idempotent (re-opens, doesn't error).
    const r2 = (await rpc(socketPath, 'session.register', {
      agentId: 'conductor',
      agentName: 'conductor',
      backend: 'claude-code',
    })) as { sessionId: string };
    expect(r2.sessionId).toBe('conductor');

    // And that stable id can now receive mail from another agent.
    await rpc(socketPath, 'mail.send', {
      actorAgentId: alice,
      to: 'conductor',
      subject: 'ping',
      body: 'hello conductor',
    });
    const inbox = (await rpc(socketPath, 'mail.inbox', {
      actorAgentId: 'conductor',
      agentId: 'conductor',
    })) as { messages: Array<{ subject: string }> };
    expect(inbox.messages.some((m) => m.subject === 'ping')).toBe(true);
  });

  it('broadcast excludes the sender', async () => {
    await rpc(socketPath, 'mail.broadcast', {
      actorAgentId: alice,
      subject: 'all-hands',
      body: 'meeting',
    });
    const aliceInbox = (await rpc(socketPath, 'mail.inbox', {
      actorAgentId: alice,
      agentId: alice,
      unreadOnly: false,
    })) as { messages: Array<{ subject: string }> };
    const bobInbox = (await rpc(socketPath, 'mail.inbox', {
      actorAgentId: bob,
      agentId: bob,
      unreadOnly: false,
    })) as { messages: Array<{ subject: string }> };
    expect(aliceInbox.messages.some((m) => m.subject === 'all-hands')).toBe(false);
    expect(bobInbox.messages.some((m) => m.subject === 'all-hands')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GAP-153 — periodic prune of stale + old-completed sessions.
//
// We use `harness.prune` (the on-demand RPC) with very small thresholds
// (fractional days, ≈ a few seconds) so the test doesn't have to wait for
// the periodic timer or the 7-day production threshold. The runPrune
// helper accepts fractional days because the SQL uses
// `INTERVAL '1 day' * $param`.
// ---------------------------------------------------------------------------

describe('GAP-153: stale-session prune', () => {
  it('harness.health includes prune state (initially zeroed)', async () => {
    const health = (await rpc(socketPath, 'harness.health')) as {
      prune?: { lastRunAt: string | null; lastAgedCount: number; lastDeletedCount: number };
    };
    expect(health.prune).toBeDefined();
    // lastRunAt may or may not have run by now (the 5s startup setTimeout
    // is unref'd but might fire); but the shape must be correct.
    expect(typeof health.prune?.lastAgedCount).toBe('number');
    expect(typeof health.prune?.lastDeletedCount).toBe('number');
  });

  it('ages out a session whose age exceeds the stale threshold', async () => {
    // Register a stable-id session, then wait briefly so its started_at
    // is older than the threshold we'll pass to prune.
    await rpc(socketPath, 'session.register', {
      agentId: 'stale-test',
      agentName: 'stale-test',
      backend: 'test',
    });

    // Sanity: row is currently active in session.list (which filters
    // to ended_at IS NULL).
    const before = (await rpc(socketPath, 'session.list')) as {
      sessions: Array<{ id: string }>;
    };
    expect(before.sessions.find((s) => s.id === 'stale-test')).toBeDefined();

    await new Promise((r) => setTimeout(r, 1100));

    // staleDays = 0.00001 → ≈ 0.86s. With the 1.1s sleep above, the
    // session is past the threshold.
    const result = (await rpc(socketPath, 'harness.prune', {
      staleDays: 0.00001,
      hardDeleteDays: 365,
    })) as { aged: number; deleted: number };
    expect(result.aged).toBeGreaterThanOrEqual(1);
    expect(result.deleted).toBe(0);

    // After prune, the row is no longer in session.list (proof its
    // ended_at + exit_summary were populated by runPrune; session.list
    // hides any row with ended_at IS NOT NULL).
    const after = (await rpc(socketPath, 'session.list')) as {
      sessions: Array<{ id: string }>;
    };
    expect(after.sessions.find((s) => s.id === 'stale-test')).toBeUndefined();
  });

  it('hard-deletes a session ended longer than hardDeleteDays', async () => {
    // Register, end, then prune with a tiny hardDeleteDays.
    await rpc(socketPath, 'session.register', {
      agentId: 'hard-delete-test',
      agentName: 'hard-delete-test',
      backend: 'test',
    });
    await rpc(socketPath, 'session.end', {
      actorAgentId: 'hard-delete-test',
      sessionId: 'hard-delete-test',
      summary: 'test end',
    });
    await new Promise((r) => setTimeout(r, 1100));

    const result = (await rpc(socketPath, 'harness.prune', {
      staleDays: 365,
      hardDeleteDays: 0.00001,
    })) as { aged: number; deleted: number };

    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const listing = (await rpc(socketPath, 'session.list')) as {
      sessions: Array<{ id: string }>;
    };
    expect(listing.sessions.find((s) => s.id === 'hard-delete-test')).toBeUndefined();
  });

  it('harness.health reports prune state after a prune run', async () => {
    await rpc(socketPath, 'harness.prune', { staleDays: 365, hardDeleteDays: 365 });
    const health = (await rpc(socketPath, 'harness.health')) as {
      prune: { lastRunAt: string | null; lastAgedCount: number; lastDeletedCount: number };
    };
    expect(health.prune.lastRunAt).not.toBeNull();
    // The aged/deleted counts reflect the LAST prune, which used very
    // permissive thresholds — should be 0 for both.
    expect(health.prune.lastAgedCount).toBe(0);
    expect(health.prune.lastDeletedCount).toBe(0);
  });

  it('clamps negative thresholds to zero (defensive)', async () => {
    // staleDays=0 → "older than NOW" → matches every session with
    // ended_at IS NULL. We need at least one such session to verify
    // the clamp is wider than negative-would-be (which Postgres
    // semantics handle the same way as 0 here, but the explicit
    // clamp is what we're checking the call doesn't error on).
    await rpc(socketPath, 'session.register', {
      agentId: 'clamp-test',
      agentName: 'clamp-test',
      backend: 'test',
    });
    const result = (await rpc(socketPath, 'harness.prune', {
      staleDays: -100,
      hardDeleteDays: 365,
    })) as { aged: number };
    // Negative was clamped to 0 → matches all unended sessions.
    expect(result.aged).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Adoption 2 Phase 1.2 — agent identity bootstrap via session.register.
//
// Proves: keygen on first register, idempotent reuse, forceRotate rotation,
// and that revvault CLI absence does not fail register (CI scenario).
// ---------------------------------------------------------------------------

describe('agent identity bootstrap', () => {
  it('first register issues DID + keypair', async () => {
    const result = (await rpc(socketPath, 'session.register', {
      agentId: 'identity-test-first',
      agentName: 'identity-tester',
      backend: 'test',
    })) as { sessionId: string; did: string; publicKeyPem: string };

    expect(result.sessionId).toBe('identity-test-first');
    expect(result.did).toBe(
      result.did.startsWith('did:revfleet:identity-test-first:')
        ? result.did
        : 'did:revfleet:identity-test-first:<fingerprint>',
    );
    expect(result.did.startsWith('did:revfleet:identity-test-first:')).toBe(true);
    expect(result.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('idempotent re-register reuses the same keypair', async () => {
    const r1 = (await rpc(socketPath, 'session.register', {
      agentId: 'identity-test-idempotent',
      agentName: 'identity-tester',
      backend: 'test',
    })) as { did: string; publicKeyPem: string };

    const r2 = (await rpc(socketPath, 'session.register', {
      agentId: 'identity-test-idempotent',
      agentName: 'identity-tester',
      backend: 'test',
    })) as { did: string; publicKeyPem: string };

    expect(r2.did).toBe(r1.did);
    expect(r2.publicKeyPem).toBe(r1.publicKeyPem);
  });

  it('forceRotate:true supersedes old key and issues a new one', async () => {
    const r1 = (await rpc(socketPath, 'session.register', {
      agentId: 'identity-test-rotate',
      agentName: 'identity-tester',
      backend: 'test',
    })) as { did: string; publicKeyPem: string };

    const r2 = (await rpc(socketPath, 'session.register', {
      agentId: 'identity-test-rotate',
      agentName: 'identity-tester',
      backend: 'test',
      forceRotate: true,
    })) as { did: string; publicKeyPem: string };

    expect(r2.did).not.toBe(r1.did);
    expect(r2.publicKeyPem).not.toBe(r1.publicKeyPem);
    expect(r2.did.startsWith('did:revfleet:identity-test-rotate:')).toBe(true);
    expect(r2.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('register succeeds when revvault CLI is absent', async () => {
    const origPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const result = (await rpc(socketPath, 'session.register', {
        agentId: 'identity-test-no-revvault',
        agentName: 'identity-tester',
        backend: 'test',
      })) as { sessionId: string; did: string; publicKeyPem: string };

      expect(result.sessionId).toBe('identity-test-no-revvault');
      expect(result.did.startsWith('did:revfleet:identity-test-no-revvault:')).toBe(true);
      expect(result.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    } finally {
      if (origPath !== undefined) {
        process.env.PATH = origPath;
      }
    }
  });

  // Per Codex P2 finding: agentIds with chars outside the DID grammar
  // (spaces, slashes, colons) used to break formatDid AFTER the
  // agent_sessions row was upserted. Schema-level refine rejects them
  // cleanly before any DB write — daemon returns -32000 with the Zod
  // refine message.
  it('rejects agentId with characters outside DID grammar (pre-upsert)', async () => {
    await expect(
      rpc(socketPath, 'session.register', {
        agentId: 'invalid/agent:name with space',
        agentName: 'identity-tester',
        backend: 'test',
      }),
    ).rejects.toThrow('invalid agentId');
  });
});
