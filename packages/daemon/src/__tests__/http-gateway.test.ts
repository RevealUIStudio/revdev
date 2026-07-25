/**
 * HTTP gateway (GAP-421 daemon-ownership ADR wire path). Proves:
 *   (a) an unpaired/unsigned HTTP request is rejected by the SAME gate that
 *       rejects the identical request on the Unix socket — one authorization
 *       path, never a parallel one (dispatchRpc, server.ts).
 *   (b) the pairing round trip (GET /api/pair -> POST /api/pair -> Bearer
 *       token) works end to end and the token then authorizes /rpc.
 *   (c) the gateway never binds a listener unless httpPort is configured —
 *       default OFF.
 */

import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDaemon } from '../server.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** Find a currently-free TCP port by binding to port 0 and reading it back. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Send one newline-delimited JSON-RPC request over the Unix socket and read one response line. */
function socketRpc(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socketPath);
    let buffer = '';
    sock.on('connect', () => {
      sock.write(`${JSON.stringify(request)}\n`);
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      sock.destroy();
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(err);
      }
    });
    sock.on('error', reject);
  });
}

describe('HttpGateway — off by default', () => {
  let dataDir: string;
  let socketPath: string;
  let originalLicenseKey: string | undefined;
  let originalPublicKey: string | undefined;

  beforeEach(async () => {
    const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
    originalLicenseKey = process.env.REVEALUI_LICENSE_KEY;
    originalPublicKey = process.env.REVDEV_LICENSE_PUBLIC_KEY;
    setTestLicenseEnv(generateTestLicense('enterprise'));
    dataDir = await mkdtemp(join(tmpdir(), 'revdev-http-gateway-off-'));
    socketPath = join(dataDir, 'harness.sock');
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    const { clearTestLicenseEnv } = await import('./test-license-helper.js');
    clearTestLicenseEnv();
    if (originalLicenseKey) process.env.REVEALUI_LICENSE_KEY = originalLicenseKey;
    if (originalPublicKey) process.env.REVDEV_LICENSE_PUBLIC_KEY = originalPublicKey;
  });

  it('never constructs a listener when httpPort is left at its default (0)', async () => {
    const d = await startDaemon({ socketPath, dataDir });
    try {
      expect(d._httpGateway).toBeNull();
    } finally {
      await d.close();
    }
  });

  it('never constructs a listener when httpPort is explicitly 0', async () => {
    const d = await startDaemon({ socketPath, dataDir, httpPort: 0 });
    try {
      expect(d._httpGateway).toBeNull();
    } finally {
      await d.close();
    }
  });
});

describe('HttpGateway — pairing + shared authorization path', () => {
  let dataDir: string;
  let socketPath: string;
  let httpPort: number;
  let close: () => Promise<void>;
  let originalLicenseKey: string | undefined;
  let originalPublicKey: string | undefined;

  beforeEach(async () => {
    const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
    originalLicenseKey = process.env.REVEALUI_LICENSE_KEY;
    originalPublicKey = process.env.REVDEV_LICENSE_PUBLIC_KEY;
    setTestLicenseEnv(generateTestLicense('enterprise'));
    dataDir = await mkdtemp(join(tmpdir(), 'revdev-http-gateway-on-'));
    socketPath = join(dataDir, 'harness.sock');
    httpPort = await getFreePort();
    const d = await startDaemon({ socketPath, dataDir, httpPort, httpHost: '127.0.0.1' });
    close = d.close;
    expect(d._httpGateway).not.toBeNull();
  });

  afterEach(async () => {
    await close?.();
    await rm(dataDir, { recursive: true, force: true });
    const { clearTestLicenseEnv } = await import('./test-license-helper.js');
    clearTestLicenseEnv();
    if (originalLicenseKey) process.env.REVEALUI_LICENSE_KEY = originalLicenseKey;
    if (originalPublicKey) process.env.REVDEV_LICENSE_PUBLIC_KEY = originalPublicKey;
  });

  const base = () => `http://127.0.0.1:${httpPort}`;

  it('refuses /rpc with no Authorization header', async () => {
    const res = await fetch(`${base()}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('refuses /api/status with no Authorization header', async () => {
    const res = await fetch(`${base()}/api/status`);
    expect(res.status).toBe(401);
  });

  it('completes the pairing round trip and the minted token then authorizes /rpc', async () => {
    const nonceRes = await fetch(`${base()}/api/pair`);
    expect(nonceRes.status).toBe(200);
    const { nonce } = (await nonceRes.json()) as { nonce: string };
    expect(typeof nonce).toBe('string');

    const secretPath = join(dataDir, 'gateway-pairing-secret');
    const secret = (await readFile(secretPath, 'utf8')).trim();
    const hmac = createHmac('sha256', secret).update(nonce).digest('hex');

    const pairRes = await fetch(`${base()}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, hmac, label: 'test' }),
    });
    expect(pairRes.status).toBe(200);
    const { token } = (await pairRes.json()) as { token: string };
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);

    const rpcRes = await fetch(`${base()}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    expect(rpcRes.status).toBe(200);
    const body = (await rpcRes.json()) as { result?: unknown; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });

  it('rejects a bad HMAC pairing response and does not mint a token', async () => {
    const nonceRes = await fetch(`${base()}/api/pair`);
    const { nonce } = (await nonceRes.json()) as { nonce: string };

    const pairRes = await fetch(`${base()}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, hmac: '00'.repeat(32) }),
    });
    expect(pairRes.status).toBe(403);
  });

  it('rejects an unsigned MUTATING_OR_CONTENT_METHODS call over HTTP with the SAME code the socket returns', async () => {
    // Pair first to obtain a valid bearer token.
    const nonceRes = await fetch(`${base()}/api/pair`);
    const { nonce } = (await nonceRes.json()) as { nonce: string };
    const secretPath = join(dataDir, 'gateway-pairing-secret');
    const secret = (await readFile(secretPath, 'utf8')).trim();
    const hmac = createHmac('sha256', secret).update(nonce).digest('hex');
    const pairRes = await fetch(`${base()}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, hmac }),
    });
    const { token } = (await pairRes.json()) as { token: string };

    // session.end is signature-required (MUTATING_OR_CONTENT_METHODS) and is
    // registered directly in server.ts (no side-effect module import needed),
    // so this exercises the gate itself rather than handler wiring.
    const request = { jsonrpc: '2.0', id: 1, method: 'session.end', params: {} };

    const httpRes = await fetch(`${base()}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
    });
    expect(httpRes.status).toBe(200); // JSON-RPC errors are 200 with an error body
    const httpBody = (await httpRes.json()) as { error?: { code: number } };
    expect(httpBody.error?.code).toBe(-32003);

    // Identical unsigned request over the Unix socket must be rejected with
    // the exact same JSON-RPC code — proving one shared authorization path
    // (dispatchRpc), not a weaker parallel one for remote traffic.
    const socketBody = await socketRpc(socketPath, request);
    const socketError = socketBody.error as { code: number } | undefined;
    expect(socketError?.code).toBe(-32003);
  });
});
