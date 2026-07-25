/**
 * B1 regression suite (GAP-421 guardrail-2 remediation).
 *
 * The merged PR #328 shipped `GET /api/stream` gated by ONLY the HTTP
 * gateway's bearer token — a transport credential that proves nothing about
 * agent identity or PTY ownership. `agent.output` (the poll-based read of
 * the exact same content) requires a verified Ed25519 signer AND
 * `owner_agent === callerAgentId`. This suite reproduces the reviewer's
 * probe shape (a bearer-token-only client reading another agent's PTY
 * output over SSE) and proves it is now rejected the same way, via the
 * signature-required `agent.streamTicket` RPC.
 *
 * @vitest-environment node
 */

import { vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ---------------------------------------------------------------------------
// Mock node-pty BEFORE any module that imports spawn.ts resolves (mirrors
// spawn.test.ts — these tests exercise ownership/auth, not the OS sandbox).
// ---------------------------------------------------------------------------

interface MockPty {
  pid: number;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  _fireData: (chunk: string) => void;
  _fireExit: (code: number) => void;
}

const ptys = new Map<number, MockPty>();
let pidCounter = 5000;

function makeMockPty(): MockPty {
  let dataCallback: ((chunk: string) => void) | null = null;
  let exitCallback: ((ev: { exitCode: number }) => void) | null = null;
  const pid = ++pidCounter;
  const pty: MockPty = {
    pid,
    onData: vi.fn((cb: (chunk: string) => void) => {
      dataCallback = cb;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((cb: (ev: { exitCode: number }) => void) => {
      exitCallback = cb;
      return { dispose: vi.fn() };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    _fireData: (chunk) => dataCallback?.(chunk),
    _fireExit: (code) => exitCallback?.({ exitCode: code }),
  };
  ptys.set(pid, pty);
  return pty;
}

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => makeMockPty()),
}));

// ---------------------------------------------------------------------------
// Imports (after mock declarations)
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDid } from '@revdev/protocol/did';
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
// Side-effect: registers agent.* (agent.spawn / agent.streamTicket / ...).
import '../spawn.js';
import {
  clearTestLicenseEnv,
  generateTestLicense,
  setTestLicenseEnv,
} from './test-license-helper.js';

// ---------------------------------------------------------------------------
// Socket-level signed RPC helper (mirrors spawn.test.ts)
// ---------------------------------------------------------------------------

interface RpcResult {
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcFrame(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  signature?: string,
): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socketPath);
    let buf = '';
    const req: Record<string, unknown> = { jsonrpc: '2.0', id: 1, method, params };
    if (signature) req['x-revdev-signature'] = signature;
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      sock.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as RpcResult);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    sock.on('error', reject);
    sock.setTimeout(5000, () => {
      sock.destroy();
      reject(new Error(`rpc timeout: ${method}`));
    });
  });
}

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
  return { agentId, fingerprint, did, publicKeyPem: kp.publicKeyPem, sign };
}

const owner = makeSigner('stream-auth-owner');
const other = makeSigner('stream-auth-other');

async function signedRpc(
  socketPath: string,
  signer: { sign: (m: string, p: Record<string, unknown>) => string },
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const resp = await rpcFrame(socketPath, method, params, signer.sign(method, params));
  if (resp.error) throw new Error(`${resp.error.code}: ${resp.error.message}`);
  return resp.result;
}

/** Read an SSE response body for `ms` milliseconds, then cancel the stream. */
async function readSseFor(res: Response, ms: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  let collected = '';
  const decoder = new TextDecoder();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => {
        setTimeout(() => resolve({ done: true, value: undefined }), Math.max(remaining, 0));
      }),
    ]);
    if (result.done) break;
    collected += decoder.decode(result.value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return collected;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let dataDir: string;
let socketPath: string;
let httpPort: number;
let close: () => Promise<void>;
let repoRoot: string;
let otherRoot: string;

function base(): string {
  return `http://127.0.0.1:${httpPort}`;
}

/** Pair over HTTP and return a bearer token (the ONLY credential a remote HTTP client normally holds). */
async function pairForBearerToken(): Promise<string> {
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
  return token;
}

beforeAll(async () => {
  process.env.REVDEV_SPAWN_CONFINEMENT = 'none';
  setTestLicenseEnv(generateTestLicense('enterprise'));
  dataDir = await mkdtemp(join(tmpdir(), 'revdev-stream-auth-'));
  socketPath = join(dataDir, 'harness.sock');
  const anchor = join(dataDir, 'trusted-client-fingerprint');
  await writeFile(
    anchor,
    `${owner.agentId}:${owner.fingerprint}\n${other.agentId}:${other.fingerprint}\n`,
  );

  httpPort = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });

  const d = await startDaemon({
    socketPath,
    dataDir,
    httpPort,
    httpHost: '127.0.0.1',
    trustedClientFingerprintPath: anchor,
    trustedAnchorRequireRootOwned: false,
  });
  close = d.close;

  for (const s of [owner, other]) {
    const reg = await rpcFrame(socketPath, 'session.register', {
      agentId: s.agentId,
      agentName: s.agentId,
      backend: 'test',
      publicKeyPem: s.publicKeyPem,
    });
    if (reg.error) throw new Error(`register ${s.agentId} failed: ${reg.error.message}`);
  }

  repoRoot = await mkdtemp(join(tmpdir(), 'revdev-stream-auth-root-'));
  otherRoot = await mkdtemp(join(tmpdir(), 'revdev-stream-auth-otherroot-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: otherRoot });
  await signedRpc(socketPath, owner, 'project.open', { repoPath: repoRoot });
  await signedRpc(socketPath, other, 'project.open', { repoPath: otherRoot });
});

afterAll(async () => {
  await close?.();
  await rm(dataDir, { recursive: true, force: true });
  clearTestLicenseEnv();
  delete process.env.REVDEV_SPAWN_CONFINEMENT;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('B1: GET /api/stream requires a signed, ownership-checked ticket', () => {
  it('reproduces the reviewer probe: a bearer-token-only client cannot read PTY output without a ticket', async () => {
    const { processId } = (await signedRpc(socketPath, owner, 'agent.spawn', {
      command: 'bash',
      repoPath: repoRoot,
    })) as { processId: string };
    const pty = [...ptys.values()].at(-1);

    const token = await pairForBearerToken();

    // Exactly the reviewer's probe: bearer token only, no ticket, no signature.
    const res = await fetch(`${base()}/api/stream/${processId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);

    // Even if the client ignored the 401 and tried to read a body, no PTY
    // content should ever have been written to this response.
    pty?._fireData('AWS_SECRET_ACCESS_KEY=leaked-via-sse\r\n');
    const body = await res.text().catch(() => '');
    expect(body).not.toContain('leaked-via-sse');
    pty?._fireExit(0);
  });

  it('rejects GET /api/stream with no processId in the path (no firehose mode)', async () => {
    const token = await pairForBearerToken();
    const res = await fetch(`${base()}/api/stream`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it('agent.streamTicket requires a signature', async () => {
    const resp = await rpcFrame(socketPath, 'agent.streamTicket', { processId: 'anything' });
    expect(resp.error?.code).toBe(-32003);
  });

  it("agent.streamTicket rejects a process owned by another agent (mirrors agent.output's check)", async () => {
    const { processId } = (await signedRpc(socketPath, owner, 'agent.spawn', {
      command: 'bash',
      repoPath: repoRoot,
    })) as { processId: string };

    await expect(signedRpc(socketPath, other, 'agent.streamTicket', { processId })).rejects.toThrow(
      /not owned by caller/,
    );
  });

  it("a minted ticket authorizes the stream and delivers only that process's output", async () => {
    const { processId: ownerProcessId } = (await signedRpc(socketPath, owner, 'agent.spawn', {
      command: 'bash',
      repoPath: repoRoot,
    })) as { processId: string };
    const ownerPty = [...ptys.values()].at(-1);

    await signedRpc(socketPath, other, 'agent.spawn', {
      command: 'bash',
      repoPath: otherRoot,
    });
    const otherPty = [...ptys.values()].at(-1);

    const { ticket } = (await signedRpc(socketPath, owner, 'agent.streamTicket', {
      processId: ownerProcessId,
    })) as { ticket: string };

    const token = await pairForBearerToken();
    const res = await fetch(`${base()}/api/stream/${ownerProcessId}?ticket=${ticket}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    ownerPty?._fireData('owner-process-output\r\n');
    otherPty?._fireData('other-process-output\r\n');

    const body = await readSseFor(res, 400);
    expect(body).toContain('owner-process-output');
    expect(body).not.toContain('other-process-output');

    ownerPty?._fireExit(0);
    otherPty?._fireExit(0);
  });

  it('a stream ticket is single-use', async () => {
    const { processId } = (await signedRpc(socketPath, owner, 'agent.spawn', {
      command: 'bash',
      repoPath: repoRoot,
    })) as { processId: string };
    const pty = [...ptys.values()].at(-1);

    const { ticket } = (await signedRpc(socketPath, owner, 'agent.streamTicket', {
      processId,
    })) as { ticket: string };
    const token = await pairForBearerToken();

    const first = await fetch(`${base()}/api/stream/${processId}?ticket=${ticket}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(first.status).toBe(200);
    await first.body?.cancel().catch(() => {});

    const replay = await fetch(`${base()}/api/stream/${processId}?ticket=${ticket}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(replay.status).toBe(401);

    pty?._fireExit(0);
  });

  it('a ticket minted for one processId cannot be presented for another', async () => {
    const { processId: procA } = (await signedRpc(socketPath, owner, 'agent.spawn', {
      command: 'bash',
      repoPath: repoRoot,
    })) as { processId: string };
    const ptyA = [...ptys.values()].at(-1);
    const { processId: procB } = (await signedRpc(socketPath, owner, 'agent.spawn', {
      command: 'bash',
      repoPath: repoRoot,
    })) as { processId: string };
    const ptyB = [...ptys.values()].at(-1);

    const { ticket } = (await signedRpc(socketPath, owner, 'agent.streamTicket', {
      processId: procA,
    })) as { ticket: string };
    const token = await pairForBearerToken();

    const res = await fetch(`${base()}/api/stream/${procB}?ticket=${ticket}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);

    ptyA?._fireExit(0);
    ptyB?._fireExit(0);
  });
});
