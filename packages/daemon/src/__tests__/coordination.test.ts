/**
 * Two-agent coordination integration tests.
 *
 * Spins up a real daemon on a throwaway socket with an isolated temp data dir,
 * connects two sockets as distinct agents, and exercises mail routing,
 * file-reservation conflict detection, and task ownership enforcement.
 *
 * Covers §5.15 exit criteria: "two or more agents coordinate via the daemon
 * without human relay," proven at the RPC layer.
 */

import { mkdtemp, rm } from 'node:fs/promises';
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
    const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n';
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

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'revdev-coord-'));
  socketPath = join(dataDir, 'harness.sock');
  const d = await startDaemon({ socketPath, dataDir });
  close = d.close;
});

afterAll(async () => {
  await close?.();
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
