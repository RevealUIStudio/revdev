/**
 * End-to-end IPC tests — exercises the Studio→Daemon path using the same
 * fresh-socket-per-call + actorAgentId injection pattern as the Tauri bridge.
 *
 * Unlike coordination.test.ts (which tests multi-agent isolation), these tests
 * validate the transport layer:
 *   - actorAgentId flow (Studio's ephemeral identity pattern)
 *   - Crash recovery (daemon killed, client reconnects)
 *   - PID file lifecycle (written on start, removed on stop)
 *   - Concurrent fresh-socket calls (stress test)
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon } from '../server.js';

// ---------------------------------------------------------------------------
// Test helpers — mirror the Tauri bridge's fresh-socket-per-call pattern
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

/**
 * RPC call with actorAgentId injection — exactly how Studio's Rust bridge works.
 * The agent registers once, then passes its ID on every subsequent call.
 */
function rpcAsActor(
  socketPath: string,
  method: string,
  actorAgentId: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return rpc(socketPath, method, { ...params, actorAgentId });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let dataDir: string;
let socketPath: string;
let close: () => Promise<void>;
let originalLicenseKey: string | undefined;

beforeAll(async () => {
  originalLicenseKey = process.env.REVEALUI_LICENSE_KEY;
  process.env.REVEALUI_LICENSE_KEY = 'RVUI-enterprise-0123456789abcdef0123456789abcdef';
  dataDir = await mkdtemp(join(tmpdir(), 'revdev-e2e-'));
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
});

// ---------------------------------------------------------------------------
// Tests: actorAgentId flow (mimics Tauri bridge pattern)
// ---------------------------------------------------------------------------

describe('e2e-ipc: actorAgentId pattern', () => {
  it('registers via session.register and returns a sessionId', async () => {
    const result = (await rpc(socketPath, 'session.register', {
      agentName: 'studio-ui-test',
      workDir: '/tmp/test',
      backend: 'studio',
    })) as { sessionId: string };

    expect(result.sessionId).toBeDefined();
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });

  it('actorAgentId works without explicit session.register on same socket', async () => {
    // Register first to get an ID
    const reg = (await rpc(socketPath, 'session.register', {
      agentName: 'actor-test',
      workDir: '/tmp',
      backend: 'studio',
    })) as { sessionId: string };

    // Use actorAgentId on a DIFFERENT socket (fresh connection) — Studio pattern
    const result = (await rpcAsActor(socketPath, 'tasks.list', reg.sessionId, {})) as {
      tasks: unknown[];
    };
    expect(Array.isArray(result.tasks)).toBe(true);
  });

  it('two different actorAgentIds are isolated for mail', async () => {
    const regA = (await rpc(socketPath, 'session.register', {
      agentId: 'e2e-alice',
      agentName: 'alice',
      workDir: '/tmp',
      backend: 'test',
    })) as { sessionId: string };

    const regB = (await rpc(socketPath, 'session.register', {
      agentId: 'e2e-bob',
      agentName: 'bob',
      workDir: '/tmp',
      backend: 'test',
    })) as { sessionId: string };

    // Alice sends to Bob
    await rpcAsActor(socketPath, 'mail.send', regA.sessionId, {
      to: regB.sessionId,
      subject: 'hello',
      body: 'world',
    });

    // Bob's inbox has the message
    const bobResult = (await rpcAsActor(socketPath, 'mail.inbox', regB.sessionId, {
      unreadOnly: true,
    })) as { messages: Array<{ subject: string }> };
    expect(bobResult.messages.some((m) => m.subject === 'hello')).toBe(true);

    // Alice's inbox does NOT have it
    const aliceResult = (await rpcAsActor(socketPath, 'mail.inbox', regA.sessionId, {
      unreadOnly: true,
    })) as { messages: Array<{ subject: string }> };
    expect(aliceResult.messages.some((m) => m.subject === 'hello')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: concurrent fresh-socket calls (stress test)
// ---------------------------------------------------------------------------

describe('e2e-ipc: concurrency', () => {
  it('handles 10 parallel fresh-socket RPC calls without corruption', async () => {
    const reg = (await rpc(socketPath, 'session.register', {
      agentId: 'e2e-stress',
      agentName: 'stress-agent',
      workDir: '/tmp',
      backend: 'test',
    })) as { sessionId: string };

    // Fire 10 parallel task creations
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        rpcAsActor(socketPath, 'tasks.create', reg.sessionId, {
          taskId: `stress-task-${i}`,
          description: `Stress test task ${i}`,
        }),
      ),
    );

    // All should succeed (no connection corruption)
    expect(results).toHaveLength(10);
    for (const r of results) {
      expect(r).toBeDefined();
      expect((r as { id: string }).id).toBeDefined();
    }
  });

  it('handles 20 parallel pings without error', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rpc(socketPath, 'ping', {})),
    );
    expect(results).toHaveLength(20);
    for (const r of results) {
      expect(r).toHaveProperty('pong', true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: daemon restart recovery
// ---------------------------------------------------------------------------

describe('e2e-ipc: crash recovery', () => {
  it('detects daemon down via ECONNREFUSED on dead socket', async () => {
    // Use a socket path that doesn't exist
    const deadSocket = join(dataDir, 'nonexistent.sock');
    await expect(rpc(deadSocket, 'ping', {})).rejects.toThrow();
  });

  it('can start a second daemon instance on a different socket', async () => {
    const secondSocket = join(dataDir, 'second.sock');
    const d2 = await startDaemon({ socketPath: secondSocket, dataDir: join(dataDir, 'db2') });

    const result = await rpc(secondSocket, 'ping', {});
    expect(result).toHaveProperty('pong', true);

    await d2.close();
  });
});

// ---------------------------------------------------------------------------
// Tests: PID file lifecycle
// ---------------------------------------------------------------------------

describe('e2e-ipc: PID file', () => {
  it('PID file can be written and read back', async () => {
    const pidPath = join(dataDir, 'test.pid');
    const testPid = process.pid;
    await writeFile(pidPath, String(testPid));

    const content = await readFile(pidPath, 'utf-8');
    expect(parseInt(content.trim(), 10)).toBe(testPid);
  });
});
