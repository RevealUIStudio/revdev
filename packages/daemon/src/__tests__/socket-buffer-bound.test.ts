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

  it('regression — does NOT reject pipelined valid frames whose combined byte count exceeds the cap', async () => {
    // Two valid pings in a single chunk where each is below the cap
    // but their concatenation exceeds the cap. Pre-fix this tripped
    // the bound because the check ran on the accumulated chunk before
    // the split; post-fix only the partial remainder + each individual
    // line are checked.
    const buildFrame = (id: number, padBytes: number): string =>
      JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', _pad: 'x'.repeat(padBytes) });

    // Each frame ~ TEST_MAX_LINE_BYTES * 0.7 → individually under cap,
    // together (with two newlines) > cap.
    const padPerFrame = Math.floor(TEST_MAX_LINE_BYTES * 0.7);
    const frame1 = buildFrame(30, padPerFrame);
    const frame2 = buildFrame(31, padPerFrame);
    expect(Buffer.byteLength(frame1, 'utf8')).toBeLessThan(TEST_MAX_LINE_BYTES);
    expect(Buffer.byteLength(frame2, 'utf8')).toBeLessThan(TEST_MAX_LINE_BYTES);
    const chunk = `${frame1}\n${frame2}\n`;
    expect(Buffer.byteLength(chunk, 'utf8')).toBeGreaterThan(TEST_MAX_LINE_BYTES);

    const events = await rawExchange([chunk]);
    const responses = parseLines(joinedData(events));
    expect(responses).toHaveLength(2);
    expect(responses.map((r) => r.id).sort()).toEqual([30, 31]);
    for (const r of responses) {
      expect((r.result as { pong?: boolean } | undefined)?.pong).toBe(true);
    }
    // No -32700 should appear (both frames are individually under the cap).
    const errs = responses.filter((r) => {
      const e = r.error as { code?: number } | undefined;
      return e?.code === -32700;
    });
    expect(errs).toHaveLength(0);
  });

  it('regression — accepts a frame exactly at the cap followed by its newline', async () => {
    // Pre-fix, `buffer.length > cap` ran on the accumulated chunk
    // BEFORE the split, so a frame of exactly cap bytes plus a newline
    // (cap+1 total) tripped the check even though the frame itself
    // honored the boundary. Post-fix, the partial-remainder check sees
    // an empty buffer (the newline split everything off) and the
    // per-line check sees a frame at exactly the cap, both passing.
    //
    // We can't actually build a valid JSON-RPC frame of exactly
    // TEST_MAX_LINE_BYTES bytes without padding — instead we use a
    // valid ping padded with a string field to land exactly at the cap.
    const baseFrame = JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'ping', _pad: '' });
    const padNeeded = TEST_MAX_LINE_BYTES - Buffer.byteLength(baseFrame, 'utf8');
    expect(padNeeded).toBeGreaterThan(0);
    const exactFrame = JSON.stringify({
      jsonrpc: '2.0',
      id: 40,
      method: 'ping',
      _pad: 'x'.repeat(padNeeded),
    });
    expect(Buffer.byteLength(exactFrame, 'utf8')).toBe(TEST_MAX_LINE_BYTES);

    const events = await rawExchange([`${exactFrame}\n`]);
    const responses = parseLines(joinedData(events));
    expect(responses).toHaveLength(1);
    expect(responses[0]?.id).toBe(40);
    expect((responses[0]?.result as { pong?: boolean } | undefined)?.pong).toBe(true);
  });

  it('regression — rejects a complete oversized frame with -32700 but keeps the socket open', async () => {
    // A single chunk arrives containing a newline-terminated frame
    // larger than the cap. The frame should be rejected with -32700
    // but the connection must NOT be destroyed — the client framed the
    // boundary correctly, they just sent too much data. A second valid
    // frame in the same connection should still get a response.
    const oversize = `${'a'.repeat(TEST_MAX_LINE_BYTES + 1)}\n`;
    const followUp = `${JSON.stringify({ jsonrpc: '2.0', id: 50, method: 'ping' })}\n`;
    const events = await rawExchange([oversize, followUp]);

    const responses = parseLines(joinedData(events));
    // Expect: one -32700 for the oversize frame, then one ok ping response.
    const errs = responses.filter((r) => {
      const e = r.error as { code?: number; message?: string } | undefined;
      return e?.code === -32700;
    });
    expect(errs.length).toBeGreaterThanOrEqual(1);
    const ping = responses.find((r) => r.id === 50);
    expect(ping).toBeDefined();
    expect((ping?.result as { pong?: boolean } | undefined)?.pong).toBe(true);
    // Socket should NOT have been destroyed by the oversize frame
    // alone — close should only fire from our test-side rawExchange
    // teardown after idle.
  });

  it('regression — counts UTF-8 bytes, not UTF-16 code units, against the cap', async () => {
    // A multibyte payload (4-byte UTF-8 emoji) of 1500 chars is 6000
    // bytes. With cap=4096, this should be rejected. With the old
    // string.length check (counting UTF-16 code units), the same
    // payload was 3000 code units and bypassed the cap.
    const emoji = '\u{1F600}'; // grinning face — 4 UTF-8 bytes, 2 UTF-16 code units
    const payload = emoji.repeat(1500);
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(TEST_MAX_LINE_BYTES);
    expect(payload.length).toBeLessThan(TEST_MAX_LINE_BYTES);

    const events = await rawExchange([payload]);
    // Payload had no newline → partial-remainder path → -32700 + destroy.
    const responses = parseLines(joinedData(events));
    expect(responses.length).toBeGreaterThanOrEqual(1);
    const err = responses[0]?.error as { code?: number } | undefined;
    expect(err?.code).toBe(-32700);
    expect(events.some((e) => e.type === 'close')).toBe(true);
  });
});
