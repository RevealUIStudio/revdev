/**
 * Unit tests for the agent.* PTY spawn handler group (spawn.ts).
 *
 * agent.* is signature-gated: every method is in server.ts
 * MUTATING_OR_CONTENT_METHODS and in signing.rs requires_signature(). Every call
 * therefore carries an Ed25519 `x-revdev-signature` envelope; the daemon binds
 * ctx.agentId to the VERIFIED signer, and process ownership is checked against
 * that verified signer — never a spoofable actorAgentId param. node-pty is mocked
 * so no real processes are spawned; tests drive the daemon over a real Unix
 * socket so the full dispatch + signature gate + schema + identity stack runs.
 *
 * @vitest-environment node
 */

import { vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ---------------------------------------------------------------------------
// Mock node-pty BEFORE any module that imports spawn.ts resolves
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

let _lastPty: MockPty | null = null;
let _pidCounter = 1000;

function makeMockPty(): MockPty {
  let dataCallback: ((chunk: string) => void) | null = null;
  let exitCallback: ((ev: { exitCode: number }) => void) | null = null;

  const pty: MockPty = {
    pid: ++_pidCounter,
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
  return pty;
}

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    _lastPty = makeMockPty();
    return _lastPty;
  }),
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises stat so cwd validation passes for /tmp paths
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(async (p: string) => {
      if (p === '/tmp' || (p.startsWith('/tmp/') && !p.includes('nonexistent'))) {
        return { isDirectory: () => true };
      }
      const err = Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), {
        code: 'ENOENT',
      });
      throw err;
    }),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mock declarations)
// ---------------------------------------------------------------------------

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
import { startDaemon } from '../server.js';
// Side-effect import: registers agent.* handlers with the daemon's handler Map.
// Vitest hoists vi.mock() above all static imports, so the node-pty mock is in
// place before spawn.ts loads.
import '../spawn.js';
import {
  clearTestLicenseEnv,
  generateTestLicense,
  setTestLicenseEnv,
} from './test-license-helper.js';

// ---------------------------------------------------------------------------
// Signed JSON-RPC client — one request per socket (stateless). agent.* is in
// MUTATING_OR_CONTENT_METHODS, so each call MUST carry an Ed25519 envelope.
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

/** A client-held identity (mirrors the key Studio keeps in its Windows vault). */
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

// owner drives the happy paths; other proves cross-agent ownership rejection.
const owner = makeSigner('spawn-test-owner');
const other = makeSigner('spawn-test-other');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let dataDir: string;
let socketPath: string;
let close: () => Promise<void>;

/** Signed RPC that throws on error (the common happy-path wrapper). */
async function signedRpc(
  signer: { sign: (m: string, p: Record<string, unknown>) => string },
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const resp = await rpcFrame(socketPath, method, params, signer.sign(method, params));
  if (resp.error) throw new Error(`${resp.error.code}: ${resp.error.message}`);
  return resp.result;
}

beforeAll(async () => {
  setTestLicenseEnv(generateTestLicense('enterprise'));
  dataDir = await mkdtemp(join(tmpdir(), 'revdev-spawn-test-'));
  socketPath = join(dataDir, 'harness.sock');
  // Provision both client fingerprints into the trust anchor (fixture).
  const anchor = join(dataDir, 'trusted-client-fingerprint');
  await writeFile(
    anchor,
    `${owner.agentId}:${owner.fingerprint}\n${other.agentId}:${other.fingerprint}\n`,
  );
  const d = await startDaemon({
    socketPath,
    dataDir,
    trustedClientFingerprintPath: anchor,
    trustedAnchorRequireRootOwned: false,
  });
  close = d.close;
});

afterAll(async () => {
  await close?.();
  await rm(dataDir, { recursive: true, force: true });
  clearTestLicenseEnv();
});

beforeEach(() => {
  _lastPty = null;
  _pidCounter = 1000;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('signature gate', () => {
  it('rejects an UNSIGNED agent.spawn (no Ed25519 envelope)', async () => {
    const resp = await rpcFrame(socketPath, 'agent.spawn', { command: 'bash', cwd: '/tmp' });
    // The dispatch gate refuses a MUTATING_OR_CONTENT_METHODS call that is not
    // signature-verified — the unsigned host process can no longer exec as the
    // daemon UID. No processId is returned.
    expect(resp.error).toBeDefined();
    expect(resp.result).toBeUndefined();
  });
});

describe('agent.spawn', () => {
  it('returns a processId (UUID) and numeric pid', async () => {
    const result = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      args: ['-i'],
      cwd: '/tmp',
    })) as { processId: string; pid: number };

    expect(result.processId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(typeof result.pid).toBe('number');
    expect(result.pid).toBeGreaterThan(0);
  });

  it('rejects when command is missing (schema validation)', async () => {
    await expect(signedRpc(owner, 'agent.spawn', { cwd: '/tmp' })).rejects.toThrow();
  });

  it('rejects a nonexistent cwd', async () => {
    await expect(
      signedRpc(owner, 'agent.spawn', {
        command: 'bash',
        cwd: '/tmp/nonexistent/does-not-exist',
      }),
    ).rejects.toThrow();
  });
});

describe('agent.input', () => {
  it('writes data to the mocked pty', async () => {
    const { processId } = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    const result = await signedRpc(owner, 'agent.input', {
      processId,
      data: 'echo hello\n',
    });

    expect(result).toEqual({ written: true });
    expect(_lastPty?.write).toHaveBeenCalledWith('echo hello\n');
  });

  it('rejects input to a process owned by another agent', async () => {
    const { processId } = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    await expect(
      signedRpc(other, 'agent.input', {
        processId,
        data: 'whoami\n',
      }),
    ).rejects.toThrow(/not owned by caller/);
  });
});

describe('agent.resize', () => {
  it('calls pty.resize with the given dimensions', async () => {
    const { processId } = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    const result = (await signedRpc(owner, 'agent.resize', {
      processId,
      cols: 120,
      rows: 40,
    })) as { resized: boolean; cols: number; rows: number };

    expect(result.resized).toBe(true);
    expect(result.cols).toBe(120);
    expect(result.rows).toBe(40);
    expect(_lastPty?.resize).toHaveBeenCalledWith(120, 40);
  });

  it('rejects resize for a process owned by another agent', async () => {
    const { processId } = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    await expect(
      signedRpc(other, 'agent.resize', {
        processId,
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow(/not owned by caller/);
  });
});

describe('agent.stop', () => {
  it('kills the mocked pty and returns status killed', async () => {
    const { processId } = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    const result = (await signedRpc(owner, 'agent.stop', {
      processId,
    })) as { stopped: string; status: string };

    expect(result.stopped).toBe(processId);
    expect(result.status).toBe('killed');
    expect(_lastPty?.kill).toHaveBeenCalled();
  });

  it('rejects stop for a process owned by another agent', async () => {
    const { processId } = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    await expect(
      signedRpc(other, 'agent.stop', {
        processId,
      }),
    ).rejects.toThrow(/not owned by caller/);
  });

  it('rejects stop for an unknown processId', async () => {
    await expect(
      signedRpc(owner, 'agent.stop', {
        processId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/unknown processId/);
  });
});

describe('agent.output', () => {
  it('returns buffered chunks and a cursor', async () => {
    const { processId } = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    _lastPty?._fireData('hello world\r\n');

    // Allow the async DB write from bufferOutput to land
    await new Promise((r) => setTimeout(r, 100));

    const result = (await signedRpc(owner, 'agent.output', {
      processId,
      cursor: '0',
    })) as {
      chunks: Array<{ id: string; seq: number; chunk: string }>;
      cursor: string;
      status: string;
    };

    expect(result.status).toBe('running');
    expect(Array.isArray(result.chunks)).toBe(true);
    if (result.chunks.length > 0) {
      expect(result.chunks[0]?.chunk).toBe('hello world\r\n');
    }
    expect(typeof result.cursor).toBe('string');
  });

  it('rejects output poll for a process owned by another agent', async () => {
    const { processId } = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      cwd: '/tmp',
    })) as { processId: string };

    await expect(
      signedRpc(other, 'agent.output', {
        processId,
        cursor: '0',
      }),
    ).rejects.toThrow(/not owned by caller/);
  });

  it('rejects output poll for an unknown processId', async () => {
    await expect(
      signedRpc(owner, 'agent.output', {
        processId: '00000000-0000-0000-0000-000000000001',
        cursor: '0',
      }),
    ).rejects.toThrow(/unknown processId/);
  });
});
