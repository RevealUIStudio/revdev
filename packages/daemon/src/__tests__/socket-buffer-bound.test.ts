/**
 * Per-socket reassembly buffer bound — DoS surface guard.
 *
 * Validates that a client who streams bytes without a newline cannot
 * grow the daemon's per-socket buffer indefinitely. On overflow, the
 * daemon must emit a JSON-RPC -32700 parse error (id null) and destroy
 * the socket.
 *
 * Tests use a tiny `maxLineBytes` cap (4 KiB) so they run fast — the
 * production default is 1 MiB.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemon } from '../server.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const TEST_MAX_LINE_BYTES = 4096;

let dataDir: string;
let socketPath: string;
let close: () => Promise<void>;
let originalLicenseKey: string | undefined;
let originalPublicKey: string | undefined;

beforeAll(async () => {
  const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
  originalLicenseKey = process.env.REVEALUI_LICENSE_KEY;
  originalPublicKey = process.env.REVDEV_LICENSE_PUBLIC_KEY;
  setTestLicenseEnv(generateTestLicense('enterprise'));
  dataDir = await mkdtemp(join(tmpdir(), 'revdev-buffer-bound-'));
  socketPath = join(dataDir, 'harness.sock');
  const d = await startDaemon({ socketPath, dataDir, maxLineBytes: TEST_MAX_LINE_BYTES });
  close = d.close;
});

afterAll(async () => {
  await close?.();
  await rm(dataDir, { recursive: true, force: true });
  const { clearTestLicenseEnv } = await import('./test-license-helper.js');
  clearTestLicenseEnv();
  if (originalLicenseKey) process.env.REVEALUI_LICENSE_KEY = originalLicenseKey;
  if (originalPublicKey) process.env.REVDEV_LICENSE_PUBLIC_KEY = originalPublicKey;
});

interface ServerEvent {
  type: 'data' | 'close' | 'error';
  data?: string;
  err?: Error;
}

/**
 * Open a raw socket, send chunks (no newline auto-added), and capture
 * everything the server sends back plus the close event. Returns once
 * the socket closes (either side) or after `idleMs` of silence with
 * the connection still open.
 */
function rawExchange(payloads: string[], idleMs = 500): Promise<ServerEvent[]> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socketPath);
    const events: ServerEvent[] = [];
    let idleTimer: NodeJS.Timeout | null = null;

    const finish = () => {
      if (idleTimer) clearTimeout(idleTimer);
      try {
        sock.destroy();
      } catch {
        /* socket may already be destroyed */
      }
      resolve(events);
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, idleMs);
    };

    sock.on('connect', () => {
      for (const p of payloads) sock.write(p);
      resetIdle();
    });
    sock.on('data', (d) => {
      events.push({ type: 'data', data: d.toString() });
      resetIdle();
    });
    sock.on('close', () => {
      events.push({ type: 'close' });
      finish();
    });
    sock.on('error', (err) => {
      events.push({ type: 'error', err });
      // Don't reject — overflow path destroys socket from server side, which
      // can surface as ECONNRESET on the client. That's expected.
      resetIdle();
    });
    sock.setTimeout(10_000, () => {
      sock.destroy();
      reject(new Error('rawExchange timeout (no events)'));
    });
  });
}

function joinedData(events: ServerEvent[]): string {
  return events
    .filter((e) => e.type === 'data')
    .map((e) => e.data ?? '')
    .join('');
}

function parseLines(joined: string): Array<Record<string, unknown>> {
  return joined
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('socket buffer bound', () => {
  it('accepts a normal under-cap request followed by newline', async () => {
    const req = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`;
    const events = await rawExchange([req]);

    const responses = parseLines(joinedData(events));
    expect(responses).toHaveLength(1);
    expect(responses[0]?.id).toBe(1);
    expect((responses[0]?.result as { pong?: boolean } | undefined)?.pong).toBe(true);
  });

  it('emits -32700 parse-error and destroys socket when a single frame exceeds maxLineBytes', async () => {
    // Stream more than maxLineBytes without ever sending a newline. The
    // server should drop the connection after emitting an error response.
    const oversize = 'a'.repeat(TEST_MAX_LINE_BYTES + 1);
    const events = await rawExchange([oversize]);

    const responses = parseLines(joinedData(events));
    expect(responses.length).toBeGreaterThanOrEqual(1);

    const resp = responses[0] as {
      jsonrpc: string;
      id: number | null;
      error: { code: number; message: string };
    };
    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBeNull();
    expect(resp.error.code).toBe(-32700);
    expect(resp.error.message).toMatch(/frame exceeded/);
    expect(resp.error.message).toContain(String(TEST_MAX_LINE_BYTES));

    // Server should have closed the socket.
    expect(events.some((e) => e.type === 'close')).toBe(true);
  });

  it('still accepts pipelined small requests on a fresh socket after a prior connection was killed', async () => {
    // Confirms the overflow path doesn't break the listener for new clients.
    const reqs =
      `${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' })}\n` +
      `${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' })}\n`;
    const events = await rawExchange([reqs]);

    const responses = parseLines(joinedData(events));
    expect(responses.length).toBe(2);
    expect(responses.map((r) => r.id).sort()).toEqual([10, 11]);
    for (const r of responses) {
      expect((r.result as { pong?: boolean } | undefined)?.pong).toBe(true);
    }
  });

  it('accumulates across chunks under the cap (split JSON across two writes is fine)', async () => {
    const full = `${JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'ping' })}\n`;
    const halfway = Math.floor(full.length / 2);
    const events = await rawExchange([full.slice(0, halfway), full.slice(halfway)]);

    const responses = parseLines(joinedData(events));
    expect(responses).toHaveLength(1);
    expect(responses[0]?.id).toBe(20);
    expect((responses[0]?.result as { pong?: boolean } | undefined)?.pong).toBe(true);
  });
});
