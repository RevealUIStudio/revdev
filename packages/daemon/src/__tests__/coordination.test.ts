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
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeFingerprint,
  generateAgentKeypair,
  generateNonce,
  hashParams,
  serializeEnvelope,
  signEnvelope,
} from '../agent-identity-crypto.js';
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
let db: PGlite;
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
  db = d._db;
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

  it('check surfaces whether a path is reserved by another agent', async () => {
    const check = (await rpc(socketPath, 'files.check', {
      actorAgentId: bob,
      paths: ['/tmp/shared/file.ts'],
    })) as { reservations: unknown[]; reservedByOther: boolean };
    expect(check.reservedByOther).toBe(true);
    expect(check.reservations).toHaveLength(0);
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

  // harness.prune is signature-required (GAP-312). These tests sign the call,
  // and because the threshold is now floored at 1 day they age rows by
  // BACKDATING `started_at` / `ended_at` through the _db handle rather than by
  // passing a sub-day threshold and sleeping. Backdating is both correct (it is
  // what a genuinely stale session looks like) and faster (no real-time waits,
  // no flake).

  it('ages out a session whose age exceeds the stale threshold', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'stale-test',
      agentName: 'stale-test',
      backend: 'test',
    });

    // Sanity: row is active in session.list (filters to ended_at IS NULL).
    const before = (await rpc(socketPath, 'session.list')) as {
      sessions: Array<{ id: string }>;
    };
    expect(before.sessions.find((s) => s.id === 'stale-test')).toBeDefined();

    // Make it genuinely stale: started 10 days ago.
    await db.query(
      "UPDATE agent_sessions SET started_at = NOW() - INTERVAL '10 days' WHERE id = $1",
      ['stale-test'],
    );

    const pruner = await seedIdentity('pruner-stale');
    const result = (await signedRpc(
      socketPath,
      'harness.prune',
      { staleDays: 7, hardDeleteDays: 365 },
      { did: pruner.did, fingerprint: pruner.fingerprint, privateKeyPem: pruner.privateKeyPem },
    )) as { aged: number; deleted: number };
    expect(result.aged).toBeGreaterThanOrEqual(1);
    expect(result.deleted).toBe(0);

    // After prune the row leaves session.list (its ended_at was populated).
    const after = (await rpc(socketPath, 'session.list')) as {
      sessions: Array<{ id: string }>;
    };
    expect(after.sessions.find((s) => s.id === 'stale-test')).toBeUndefined();
  });

  it('hard-deletes a session ended longer than hardDeleteDays', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'hard-delete-test',
      agentName: 'hard-delete-test',
      backend: 'test',
    });
    // session.end is signature-required and self-scopes to the signer.
    const ender = await seedIdentity('hard-delete-test');
    await signedRpc(
      socketPath,
      'session.end',
      { summary: 'test end' },
      { did: ender.did, fingerprint: ender.fingerprint, privateKeyPem: ender.privateKeyPem },
    );
    // Backdate the end so it is older than hardDeleteDays.
    await db.query(
      "UPDATE agent_sessions SET ended_at = NOW() - INTERVAL '40 days' WHERE id = $1",
      ['hard-delete-test'],
    );

    const pruner = await seedIdentity('pruner-hard');
    const result = (await signedRpc(
      socketPath,
      'harness.prune',
      { staleDays: 365, hardDeleteDays: 30 },
      { did: pruner.did, fingerprint: pruner.fingerprint, privateKeyPem: pruner.privateKeyPem },
    )) as { aged: number; deleted: number };

    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const listing = (await rpc(socketPath, 'session.list')) as {
      sessions: Array<{ id: string }>;
    };
    expect(listing.sessions.find((s) => s.id === 'hard-delete-test')).toBeUndefined();
  });

  it('harness.health reports prune state after a prune run', async () => {
    const pruner = await seedIdentity('pruner-health');
    await signedRpc(
      socketPath,
      'harness.prune',
      { staleDays: 365, hardDeleteDays: 365 },
      { did: pruner.did, fingerprint: pruner.fingerprint, privateKeyPem: pruner.privateKeyPem },
    );
    const health = (await rpc(socketPath, 'harness.health')) as {
      prune: { lastRunAt: string | null; lastAgedCount: number; lastDeletedCount: number };
    };
    expect(health.prune.lastRunAt).not.toBeNull();
    // The aged/deleted counts reflect the LAST prune, which used very
    // permissive thresholds — should be 0 for both.
    expect(health.prune.lastAgedCount).toBe(0);
    expect(health.prune.lastDeletedCount).toBe(0);
  });

  // GAP-312 adversarial isolation. The prior test here ("clamps negative
  // thresholds to zero (defensive)") asserted the VULNERABILITY as intended:
  // it fired an UNSIGNED prune with staleDays: -100, expected it to succeed,
  // and expected it to age every unended session. That is exactly the
  // fleet-wide kill switch. It is replaced by the two properties the fix must
  // hold. Both were shown red against the pre-fix handler before landing.

  it('rejects an UNSIGNED harness.prune and evicts nothing (GAP-312)', async () => {
    // A live session the attacker would try to reap.
    await rpc(socketPath, 'session.register', {
      agentId: 'victim-unsigned',
      agentName: 'victim-unsigned',
      backend: 'test',
    });

    // A valid-schema threshold, so this isolates the SIGNATURE gate rather than
    // the floor: an unsigned caller is rejected with -32003 before the handler.
    // (The staleDays: 0 exploit frame is covered by the floor test below, where
    // the schema rejects it with -32602 first.)
    await expect(
      rpc(socketPath, 'harness.prune', { staleDays: 7, hardDeleteDays: 30 }),
    ).rejects.toThrow(/-32003|[Ss]ignature required/);

    // The victim is untouched: still active in session.list.
    const listing = (await rpc(socketPath, 'session.list')) as {
      sessions: Array<{ id: string }>;
    };
    expect(listing.sessions.find((s) => s.id === 'victim-unsigned')).toBeDefined();
  });

  it('rejects a SIGNED harness.prune with a sub-day threshold (GAP-312 floor)', async () => {
    await rpc(socketPath, 'session.register', {
      agentId: 'victim-floor',
      agentName: 'victim-floor',
      backend: 'test',
    });

    // Even a validly signed caller cannot select "every session": the schema
    // floors staleDays at 1, so 0 (and any value < 1) is rejected as invalid
    // params before the handler runs.
    const pruner = await seedIdentity('pruner-floor');
    await expect(
      signedRpc(
        socketPath,
        'harness.prune',
        { staleDays: 0 },
        { did: pruner.did, fingerprint: pruner.fingerprint, privateKeyPem: pruner.privateKeyPem },
      ),
    ).rejects.toThrow();

    const listing = (await rpc(socketPath, 'session.list')) as {
      sessions: Array<{ id: string }>;
    };
    expect(listing.sessions.find((s) => s.id === 'victim-floor')).toBeDefined();
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
    })) as { sessionId: string; did: string; publicKeyPem: string; privateKeyPem?: string };

    expect(result.sessionId).toBe('identity-test-first');
    expect(result.did).toBe(
      result.did.startsWith('did:revfleet:identity-test-first:')
        ? result.did
        : 'did:revfleet:identity-test-first:<fingerprint>',
    );
    expect(result.did.startsWith('did:revfleet:identity-test-first:')).toBe(true);
    expect(result.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    // INIT-002 Phase 1: one-shot private key so headless hooks can sign.
    expect(result.privateKeyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('idempotent re-register reuses the same keypair', async () => {
    const r1 = (await rpc(socketPath, 'session.register', {
      agentId: 'identity-test-idempotent',
      agentName: 'identity-tester',
      backend: 'test',
    })) as { did: string; publicKeyPem: string; privateKeyPem?: string };

    const r2 = (await rpc(socketPath, 'session.register', {
      agentId: 'identity-test-idempotent',
      agentName: 'identity-tester',
      backend: 'test',
    })) as { did: string; publicKeyPem: string; privateKeyPem?: string };

    expect(r2.did).toBe(r1.did);
    expect(r2.publicKeyPem).toBe(r1.publicKeyPem);
    // Private key is emitted only on first mint — never re-emitted.
    expect(r1.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(r2.privateKeyPem).toBeUndefined();
  });

  it('forceRotate param is silently ignored — re-register returns the same keypair', async () => {
    // forceRotate was an unauthenticated key-rotation escape hatch removed in
    // B6 item 0b. Passing it must not cause key supersession.
    const r1 = (await rpc(socketPath, 'session.register', {
      agentId: 'identity-test-rotate-ignored',
      agentName: 'identity-tester',
      backend: 'test',
    })) as { did: string; publicKeyPem: string };

    const r2 = (await rpc(socketPath, 'session.register', {
      agentId: 'identity-test-rotate-ignored',
      agentName: 'identity-tester',
      backend: 'test',
      forceRotate: true,
    })) as { did: string; publicKeyPem: string };

    expect(r2.did).toBe(r1.did);
    expect(r2.publicKeyPem).toBe(r1.publicKeyPem);
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

// ---------------------------------------------------------------------------
// Adoption 2 Phase 1.3 — accept-if-present signature gate.
//
// Tests use pre-seeded DB rows (known keypairs inserted directly into
// agent_identity + agent_identity_keys via the _db handle) so the test
// holds both the public and private key — bypassing revvault, which is not
// available in CI.
// ---------------------------------------------------------------------------

function signedRpc(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  opts: { did: string; fingerprint: string; privateKeyPem: string },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socketPath);
    let buf = '';
    const payload = {
      did: opts.did,
      kid: opts.fingerprint,
      nonce: generateNonce(),
      ts: Math.floor(Date.now() / 1000),
      method,
      paramsHash: hashParams(method, params),
    };
    const envelope = signEnvelope(payload, opts.privateKeyPem);
    const sig = serializeEnvelope(envelope);
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params, 'x-revdev-signature': sig })}\n`;
    sock.on('connect', () => sock.write(frame));
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
      reject(new Error(`signedRpc timeout: ${method}`));
    });
  });
}

async function seedIdentity(agentId: string): Promise<{
  did: string;
  fingerprint: string;
  privateKeyPem: string;
  publicKeyPem: string;
}> {
  const kp = generateAgentKeypair();
  const fingerprint = computeFingerprint(kp.publicKeyRaw);
  const { formatDid } = await import('@revdev/protocol/did');
  const did = formatDid(agentId, fingerprint);
  await db.query(
    `INSERT INTO agent_identity (agent_id, did, fingerprint, public_key_pem)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_id) DO UPDATE
       SET did = EXCLUDED.did,
           fingerprint = EXCLUDED.fingerprint,
           public_key_pem = EXCLUDED.public_key_pem`,
    [agentId, did, fingerprint, kp.publicKeyPem],
  );
  await db.query(
    `UPDATE agent_identity_keys SET superseded_at = NOW() WHERE agent_id = $1 AND superseded_at IS NULL`,
    [agentId],
  );
  await db.query(
    `INSERT INTO agent_identity_keys (fingerprint, agent_id, public_key_pem)
     VALUES ($1, $2, $3)`,
    [fingerprint, agentId, kp.publicKeyPem],
  );
  await db.query(
    `INSERT INTO agent_sessions (id, env, task) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET ended_at = NULL, exit_summary = NULL`,
    [agentId, `test:${agentId}`, ''],
  );
  return { did, fingerprint, privateKeyPem: kp.privateKeyPem, publicKeyPem: kp.publicKeyPem };
}

describe('signature acceptance', () => {
  it('harness.health returns identitySignatureMode: accept-if-present', async () => {
    const health = (await rpc(socketPath, 'harness.health')) as {
      identitySignatureMode: string;
    };
    expect(health.identitySignatureMode).toBe('accept-if-present');
  });

  it('valid signature binds identity (signed mail.inbox without actorAgentId)', async () => {
    const agentId = 'sig-test-valid';
    const { did, fingerprint, privateKeyPem } = await seedIdentity(agentId);

    const result = (await signedRpc(
      socketPath,
      'mail.inbox',
      { unreadOnly: false },
      { did, fingerprint, privateKeyPem },
    )) as { messages: unknown[] };

    expect(Array.isArray(result.messages)).toBe(true);
  });

  it('missing signature falls through to actorAgentId (existing behavior unchanged)', async () => {
    const agentId = 'sig-test-missing';
    await seedIdentity(agentId);

    const result = (await rpc(socketPath, 'mail.inbox', {
      actorAgentId: agentId,
      unreadOnly: false,
    })) as { messages: unknown[] };
    expect(Array.isArray(result.messages)).toBe(true);
  });

  it('invalid signature falls through: returns -32002 without actorAgentId', async () => {
    const agentId = 'sig-test-invalid';
    const { did, fingerprint } = await seedIdentity(agentId);
    const other = generateAgentKeypair();

    await expect(
      signedRpc(
        socketPath,
        'mail.inbox',
        { unreadOnly: false },
        { did, fingerprint, privateKeyPem: other.privateKeyPem },
      ),
    ).rejects.toThrow('-32002');
  });

  it('nonce replay falls through on second send: -32002 without actorAgentId', async () => {
    const agentId = 'sig-test-nonce-replay';
    const { did, fingerprint, privateKeyPem } = await seedIdentity(agentId);

    const nonce = generateNonce();
    const ts = Math.floor(Date.now() / 1000);

    function sendWithFixedNonce(): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const sock: Socket = connect(socketPath);
        let buf = '';
        const payload = {
          did,
          kid: fingerprint,
          nonce,
          ts,
          method: 'mail.inbox',
          paramsHash: hashParams('mail.inbox', { unreadOnly: false }),
        };
        const envelope = signEnvelope(payload, privateKeyPem);
        const sig = serializeEnvelope(envelope);
        const frame = `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'mail.inbox',
          params: { unreadOnly: false },
          'x-revdev-signature': sig,
        })}\n`;
        sock.on('connect', () => sock.write(frame));
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
          reject(new Error('timeout'));
        });
      });
    }

    await sendWithFixedNonce();

    await expect(sendWithFixedNonce()).rejects.toThrow('-32002');
  });

  it('ts-outside-window falls through: -32002 without actorAgentId', async () => {
    const agentId = 'sig-test-ts-window';
    const { did, fingerprint, privateKeyPem } = await seedIdentity(agentId);

    const staleTs = Math.floor(Date.now() / 1000) - 120;
    const payload = {
      did,
      kid: fingerprint,
      nonce: generateNonce(),
      ts: staleTs,
      method: 'mail.inbox',
      paramsHash: hashParams('mail.inbox', { unreadOnly: false }),
    };
    const envelope = signEnvelope(payload, privateKeyPem);
    const sig = serializeEnvelope(envelope);

    await expect(
      new Promise((resolve, reject) => {
        const sock: Socket = connect(socketPath);
        let buf = '';
        const frame = `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'mail.inbox',
          params: { unreadOnly: false },
          'x-revdev-signature': sig,
        })}\n`;
        sock.on('connect', () => sock.write(frame));
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
          reject(new Error('timeout'));
        });
      }),
    ).rejects.toThrow('-32002');
  });

  it('envelope tamper detected: signature verify fails, falls through to -32002', async () => {
    const agentId = 'sig-test-tamper';
    const { did, fingerprint, privateKeyPem } = await seedIdentity(agentId);

    const payload = {
      did,
      kid: fingerprint,
      nonce: generateNonce(),
      ts: Math.floor(Date.now() / 1000),
      method: 'mail.inbox',
      paramsHash: hashParams('mail.inbox', { unreadOnly: false }),
    };
    const envelope = signEnvelope(payload, privateKeyPem);
    const serialized = serializeEnvelope(envelope);
    const parts = serialized.split('.');
    const sigBytes = Buffer.from(parts[2] ?? '', 'base64url');
    if (sigBytes.length > 0) sigBytes[0] = (sigBytes[0] ?? 0) ^ 0xff;
    const tampered = `${parts[0]}.${parts[1]}.${sigBytes.toString('base64url')}`;

    await expect(
      new Promise((resolve, reject) => {
        const sock: Socket = connect(socketPath);
        let buf = '';
        const frame = `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'mail.inbox',
          params: { unreadOnly: false },
          'x-revdev-signature': tampered,
        })}\n`;
        sock.on('connect', () => sock.write(frame));
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
          reject(new Error('timeout'));
        });
      }),
    ).rejects.toThrow('-32002');
  });

  // Per Codex P1 finding: a signed request on a reused socket must NOT leave
  // ctx.agentId set for subsequent unsigned requests. verifyOrWarn resets the
  // signature binding on every call; the next unsigned call sees the connection
  // back at its pre-signature state (here: unbound) and is rejected with -32002.
  it('signed-then-unsigned on same socket: unsigned does NOT inherit signature identity', async () => {
    const agentId = 'sig-test-leak-cleanup';
    const { did, fingerprint, privateKeyPem } = await seedIdentity(agentId);

    const payload = {
      did,
      kid: fingerprint,
      nonce: generateNonce(),
      ts: Math.floor(Date.now() / 1000),
      method: 'mail.inbox',
      paramsHash: hashParams('mail.inbox', { unreadOnly: false }),
    };
    const envelope = signEnvelope(payload, privateKeyPem);
    const sig = serializeEnvelope(envelope);

    const responses = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const sock: Socket = connect(socketPath);
      const out: Array<Record<string, unknown>> = [];
      let buf = '';

      const signedFrame = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'mail.inbox',
        params: { unreadOnly: false },
        'x-revdev-signature': sig,
      })}\n`;
      const unsignedFrame = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'mail.inbox',
        params: { unreadOnly: false },
      })}\n`;

      sock.on('connect', () => {
        sock.write(signedFrame);
        sock.write(unsignedFrame);
      });
      sock.on('data', (d) => {
        buf += d.toString();
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.length > 0) {
            try {
              out.push(JSON.parse(line) as Record<string, unknown>);
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
              return;
            }
          }
          if (out.length === 2) {
            sock.end();
            resolve(out);
            return;
          }
          nl = buf.indexOf('\n');
        }
      });
      sock.on('error', reject);
      sock.setTimeout(5000, () => {
        sock.destroy();
        reject(new Error('socket reuse test timeout'));
      });
    });

    // First (signed) call succeeded as the signed agent.
    expect(responses[0]?.id).toBe(1);
    expect(responses[0]?.error).toBeUndefined();

    // Second (unsigned) call on the SAME socket was rejected with -32002.
    // If the signature identity had leaked, the unsigned call would have
    // succeeded as the signed agent — proving the cleanup logic correct.
    expect(responses[1]?.id).toBe(2);
    const err = responses[1]?.error as { code: number; message: string } | undefined;
    expect(err?.code).toBe(-32002);
  });
});

// ---------------------------------------------------------------------------
// GAP-257 — session activity-state (self-scoped state + active-window).
//
// Proves: (1) state is SELF-SCOPED — a signed caller cannot flip another
// session's state via the params override (the session.end cross-agent hole
// must NOT be recreated); (2) the active-window derivation drops a session
// out of "active" once updated_at ages past the window; (3) blocked → active
// clears blocked_since; (4) unbound/invalid state calls are rejected.
// ---------------------------------------------------------------------------

type ListedSession = {
  id: string;
  activity_state?: string;
  blocked_reason?: string | null;
  blocked_since?: string | null;
  active?: boolean;
  staleSeconds?: number;
};

async function listLocal(): Promise<ListedSession[]> {
  const r = (await rpc(socketPath, 'session.list')) as { sessions: ListedSession[] };
  return r.sessions;
}

describe('GAP-257: session activity-state', () => {
  it('state is self-scoped — a signed caller cannot set ANOTHER session state', async () => {
    const a = await seedIdentity('gap257-self-a');
    await seedIdentity('gap257-self-b');

    // Signed as A, but naming B in the override params. State must land on A.
    const res = (await signedRpc(
      socketPath,
      'session.update',
      { sessionId: 'gap257-self-b', agentId: 'gap257-self-b', state: 'blocked' },
      { did: a.did, fingerprint: a.fingerprint, privateKeyPem: a.privateKeyPem },
    )) as { updated: string; stateScopedTo: string };
    expect(res.stateScopedTo).toBe('gap257-self-a');

    const sessions = await listLocal();
    const rowA = sessions.find((s) => s.id === 'gap257-self-a');
    const rowB = sessions.find((s) => s.id === 'gap257-self-b');
    // A (the signer) is blocked; B (the named target) is untouched.
    expect(rowA?.activity_state).toBe('blocked');
    expect(rowA?.blocked_reason).toBe('permission');
    expect(rowA?.blocked_since).toBeTruthy();
    expect(rowB?.activity_state).toBe('active');
    expect(rowB?.blocked_since).toBeFalsy();
  });

  it('a caller that passes the identity gate but is NOT bound cannot set state', async () => {
    // actorAgentId clears the dispatch identity gate, but does NOT bind
    // ctx.agentId — so the handler's self-scope check must still reject. This
    // proves state requires register/attach/sign, never just a claimed id.
    await seedIdentity('gap257-unbound-target');
    await expect(
      rpc(socketPath, 'session.update', {
        actorAgentId: 'gap257-unbound-target',
        sessionId: 'gap257-unbound-target',
        state: 'blocked',
      }),
    ).rejects.toThrow(/requires a bound session/);

    const sessions = await listLocal();
    expect(sessions.find((s) => s.id === 'gap257-unbound-target')?.activity_state).toBe('active');
  });

  it('rejects an invalid state value (schema enum + handler guard)', async () => {
    const a = await seedIdentity('gap257-invalid');
    // Rejected at the validation edge (-32602) by the schema enum; the
    // handler keeps a defensive VALID_ACTIVITY_STATES guard behind it.
    await expect(
      signedRpc(
        socketPath,
        'session.update',
        { state: 'wat' },
        { did: a.did, fingerprint: a.fingerprint, privateKeyPem: a.privateKeyPem },
      ),
    ).rejects.toThrow();
  });

  it('derives active=false once updated_at ages past the active window', async () => {
    await seedIdentity('gap257-window');
    // Freshly seeded → within the window → active.
    let row = (await listLocal()).find((s) => s.id === 'gap257-window');
    expect(row?.active).toBe(true);
    expect(typeof row?.staleSeconds).toBe('number');

    // Age updated_at well past the default 120s window (the row still declares
    // activity_state='active'; only the heartbeat fallback drops it).
    await db.query(
      `UPDATE agent_sessions SET updated_at = NOW() - INTERVAL '500 seconds' WHERE id = $1`,
      ['gap257-window'],
    );
    row = (await listLocal()).find((s) => s.id === 'gap257-window');
    expect(row?.activity_state).toBe('active');
    expect(row?.active).toBe(false);
    expect(row?.staleSeconds).toBeGreaterThanOrEqual(500);
  });

  it('blocked → active clears blocked_since and blocked_reason', async () => {
    const a = await seedIdentity('gap257-trans');
    const keys = { did: a.did, fingerprint: a.fingerprint, privateKeyPem: a.privateKeyPem };

    await signedRpc(socketPath, 'session.update', { state: 'blocked' }, keys);
    let row = (await listLocal()).find((s) => s.id === 'gap257-trans');
    expect(row?.activity_state).toBe('blocked');
    expect(row?.blocked_since).toBeTruthy();

    await signedRpc(socketPath, 'session.update', { state: 'active' }, keys);
    row = (await listLocal()).find((s) => s.id === 'gap257-trans');
    expect(row?.activity_state).toBe('active');
    expect(row?.blocked_since).toBeFalsy();
    expect(row?.blocked_reason).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// GAP-307: tool-use events.log advances session heartbeat (updated_at)
// ---------------------------------------------------------------------------

describe('GAP-307: events.log tool-use heartbeats session.list active', () => {
  it('tool-use with payload.sessionId bumps updated_at and restores active', async () => {
    await seedIdentity('gap307-hb');
    await db.query(
      `UPDATE agent_sessions SET updated_at = NOW() - INTERVAL '500 seconds' WHERE id = $1`,
      ['gap307-hb'],
    );
    let row = (await listLocal()).find((s) => s.id === 'gap307-hb');
    expect(row?.active).toBe(false);

    // track-tools.js shape: actorAgentId + agentId + eventType tool-use + sessionId
    await rpc(socketPath, 'events.log', {
      actorAgentId: 'gap307-hb',
      agentId: 'gap307-hb',
      eventType: 'tool-use',
      payload: { tool: 'Bash', sessionId: 'gap307-hb' },
    });

    // Allow fire-and-forget UPDATE to land
    await new Promise((r) => setTimeout(r, 50));
    row = (await listLocal()).find((s) => s.id === 'gap307-hb');
    expect(row?.active).toBe(true);
    expect(row?.staleSeconds).toBeLessThan(30);
  });

  it('non-tool-use events do not revive a stale session', async () => {
    await seedIdentity('gap307-other');
    await db.query(
      `UPDATE agent_sessions SET updated_at = NOW() - INTERVAL '500 seconds' WHERE id = $1`,
      ['gap307-other'],
    );
    await rpc(socketPath, 'events.log', {
      actorAgentId: 'gap307-other',
      agentId: 'gap307-other',
      eventType: 'custom',
      payload: { sessionId: 'gap307-other' },
    });
    await new Promise((r) => setTimeout(r, 50));
    const row = (await listLocal()).find((s) => s.id === 'gap307-other');
    expect(row?.active).toBe(false);
  });
});
