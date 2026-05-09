/**
 * Tests for graceful-shutdown drain — server.close() waits for in-flight
 * RPC handlers before tearing down PGlite + the Unix socket.
 *
 * Two layers:
 *  - Direct exercise of the drain helper (`_drainActiveHandlersForTest`)
 *    using the test-only counter setter (`_setActiveHandlerCountForTest`).
 *    Deterministic; no daemon, no socket.
 *  - One end-to-end sanity test that exercises a real startDaemon →
 *    close() cycle with no in-flight handlers (drain returns immediately).
 *    Confirms the close()-side wiring doesn't regress.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _drainActiveHandlersForTest,
  _setActiveHandlerCountForTest,
  _setClosingForTest,
  startDaemon,
} from '../server.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('drainActiveHandlers (helper)', () => {
  beforeEach(() => {
    _setActiveHandlerCountForTest(0);
  });

  afterEach(() => {
    _setActiveHandlerCountForTest(0);
  });

  it('returns drained:true immediately when no handlers are in flight', async () => {
    const start = Date.now();
    const result = await _drainActiveHandlersForTest(1000);
    const elapsed = Date.now() - start;
    expect(result.drained).toBe(true);
    expect(result.remaining).toBe(0);
    // Should resolve well under the deadline — first poll observes count=0.
    expect(elapsed).toBeLessThan(50);
  });

  it('waits while count > 0 and resolves when it drops to zero', async () => {
    _setActiveHandlerCountForTest(2);
    // Decrement asynchronously so the drain has to poll.
    setTimeout(() => _setActiveHandlerCountForTest(1), 30);
    setTimeout(() => _setActiveHandlerCountForTest(0), 60);

    const start = Date.now();
    const result = await _drainActiveHandlersForTest(1000);
    const elapsed = Date.now() - start;

    expect(result.drained).toBe(true);
    expect(result.remaining).toBe(0);
    // Should finish near the second decrement (~60 ms) not near the deadline.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(500);
  });

  it('returns drained:false with remaining count when deadline expires', async () => {
    _setActiveHandlerCountForTest(3);
    const start = Date.now();
    const result = await _drainActiveHandlersForTest(80);
    const elapsed = Date.now() - start;

    expect(result.drained).toBe(false);
    expect(result.remaining).toBe(3);
    // Deadline-bounded — should not significantly overshoot.
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(300);
  });

  it('handles fractional decrement progress that still misses the deadline', async () => {
    _setActiveHandlerCountForTest(5);
    // Drop to 2 inside the window; deadline still fires before reaching 0.
    setTimeout(() => _setActiveHandlerCountForTest(2), 30);

    const result = await _drainActiveHandlersForTest(80);
    expect(result.drained).toBe(false);
    expect(result.remaining).toBe(2);
  });

  it('respects a custom tick interval (slower polls still resolve)', async () => {
    _setActiveHandlerCountForTest(1);
    setTimeout(() => _setActiveHandlerCountForTest(0), 50);

    const result = await _drainActiveHandlersForTest(1000, 25);
    expect(result.drained).toBe(true);
  });
});

describe('startDaemon().close() — drain integration', () => {
  let dataDir: string;
  let socketPath: string;
  let originalLicenseKey: string | undefined;
  let originalPublicKey: string | undefined;

  beforeEach(async () => {
    const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
    originalLicenseKey = process.env.REVEALUI_LICENSE_KEY;
    originalPublicKey = process.env.REVDEV_LICENSE_PUBLIC_KEY;
    setTestLicenseEnv(generateTestLicense('enterprise'));
    dataDir = await mkdtemp(join(tmpdir(), 'revdev-drain-'));
    socketPath = join(dataDir, 'harness.sock');
    _setActiveHandlerCountForTest(0);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    _setActiveHandlerCountForTest(0);
    const { clearTestLicenseEnv } = await import('./test-license-helper.js');
    clearTestLicenseEnv();
    if (originalLicenseKey) process.env.REVEALUI_LICENSE_KEY = originalLicenseKey;
    if (originalPublicKey) process.env.REVDEV_LICENSE_PUBLIC_KEY = originalPublicKey;
  });

  it('completes promptly when no handlers are in flight', async () => {
    const d = await startDaemon({ socketPath, dataDir, shutdownGracePeriodMs: 1000 });
    const start = Date.now();
    await d.close();
    const elapsed = Date.now() - start;
    // No handlers in flight — drain should resolve on the first poll.
    // Most of the elapsed time is db.close() + unlink, not the drain.
    expect(elapsed).toBeLessThan(2000);
  });

  it('does not exceed the configured grace period when a stuck handler is simulated', async () => {
    const d = await startDaemon({ socketPath, dataDir, shutdownGracePeriodMs: 100 });
    // Simulate a stuck handler by bumping the counter directly. close()'s
    // drain should hit the deadline, log a warning, and proceed.
    _setActiveHandlerCountForTest(1);
    const start = Date.now();
    await d.close();
    const elapsed = Date.now() - start;
    // Should pass the 100 ms drain deadline plus db.close() + unlink time,
    // but shouldn't hang indefinitely.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(3000);
    // Counter is still 1 (we never decremented it from the test side).
    // Reset for afterEach.
    _setActiveHandlerCountForTest(0);
  });
});

describe('shutdown gate (regression — Codex P2 catch on revdev#47)', () => {
  let dataDir: string;
  let socketPath: string;
  let originalLicenseKey: string | undefined;
  let originalPublicKey: string | undefined;

  beforeEach(async () => {
    const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
    originalLicenseKey = process.env.REVEALUI_LICENSE_KEY;
    originalPublicKey = process.env.REVDEV_LICENSE_PUBLIC_KEY;
    setTestLicenseEnv(generateTestLicense('enterprise'));
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    dataDir = await mkdtemp(join(tmpdir(), 'revdev-closing-'));
    socketPath = join(dataDir, 'harness.sock');
    _setActiveHandlerCountForTest(0);
    _setClosingForTest(false);
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dataDir, { recursive: true, force: true });
    _setActiveHandlerCountForTest(0);
    _setClosingForTest(false);
    const { clearTestLicenseEnv } = await import('./test-license-helper.js');
    clearTestLicenseEnv();
    if (originalLicenseKey) process.env.REVEALUI_LICENSE_KEY = originalLicenseKey;
    if (originalPublicKey) process.env.REVDEV_LICENSE_PUBLIC_KEY = originalPublicKey;
  });

  function rpcOnce(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
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
          resolve(JSON.parse(line));
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

  it('rejects RPCs with -32099 once _closing is set, before incrementing the handler counter', async () => {
    const d = await startDaemon({ socketPath, dataDir });
    // Simulate the close() entrypoint having flipped the gate, but the
    // listener is still up so the request reaches dispatch.
    _setClosingForTest(true);

    const resp = (await rpcOnce('ping')) as {
      jsonrpc: string;
      id: number;
      error?: { code: number; message: string };
      result?: unknown;
    };
    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBe(1);
    expect(resp.result).toBeUndefined();
    expect(resp.error).toBeDefined();
    expect(resp.error?.code).toBe(-32099);
    expect(resp.error?.message).toBe('Server is shutting down');

    // Critical: the gated request must NOT have incremented the counter
    // — otherwise close()'s drain would observe a phantom in-flight
    // handler and either wait or warn unnecessarily.
    expect((await _drainActiveHandlersForTest(0)).remaining).toBe(0);

    _setClosingForTest(false);
    await d.close();
  });

  it('clears _closing on a fresh startDaemon so the gate is independent across lifecycles', async () => {
    const d1 = await startDaemon({ socketPath, dataDir });
    await d1.close();
    // After close() returns, _closing is reset to false. A new startDaemon
    // observed in the same process must NOT carry over the gate.
    const d2 = await startDaemon({ socketPath, dataDir });
    const resp = (await rpcOnce('ping')) as { result?: { pong?: boolean } };
    expect(resp.result?.pong).toBe(true);
    await d2.close();
  });

  it('destroys persistent sockets on close — pre-existing connections cannot dispatch RPCs against a closed daemon (Codex round-2 catch)', async () => {
    const d = await startDaemon({ socketPath, dataDir });

    // Open a long-lived socket BEFORE close() — like a Studio app would.
    const sock: Socket = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve());
      sock.once('error', reject);
    });
    expect(sock.destroyed).toBe(false);

    // Trigger close(). Per the new sequence, all open sockets get
    // destroyed before the drain.
    await d.close();

    // The pre-existing socket should now be destroyed. If it weren't,
    // a `data` event could still fire and dispatch against the closed
    // PGlite — the very race Codex flagged.
    expect(sock.destroyed).toBe(true);
  });
});
