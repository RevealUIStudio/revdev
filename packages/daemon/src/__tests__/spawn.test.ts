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

// `node:fs/promises` is deliberately NOT mocked. agent.spawn now authorizes its
// cwd against a registered project root, and that check rests on real inode
// identity (dev/ino) and real symlink resolution. A stubbed `stat` would fake
// the filesystem the security boundary is built on, so these tests use real
// temp directories instead.

// ---------------------------------------------------------------------------
// Imports (after mock declarations)
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
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
let db: PGlite;
/** A project root `owner` opens; agent.spawn now authorizes against it. */
let repoRoot: string;
/** A root owned by `other`, used to prove cross-agent spawn is refused. */
let otherRoot: string;

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
  // These tests exercise the signature gate, ownership, and project-grant
  // authorization — NOT the OS sandbox (that is proven with real bwrap in
  // confinement-integration.test.ts). node-pty is mocked here, so an actual
  // bwrap wrap is neither observable nor desirable, and the daemon must not
  // fail closed on a CI runner without bwrap. Run these under the operator
  // escape hatch: spawns are unconfined and record confinement='none'.
  process.env.REVDEV_SPAWN_CONFINEMENT = 'none';
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
  db = d._db;

  // Persist each client's public key so the daemon can Ed25519-verify their
  // signed agent.* calls (the trust anchor only holds the fingerprint). One-time
  // session.register per identity — the same bootstrap the Studio client does.
  for (const s of [owner, other]) {
    const reg = await rpcFrame(socketPath, 'session.register', {
      agentId: s.agentId,
      agentName: s.agentId,
      backend: 'test',
      publicKeyPem: s.publicKeyPem,
    });
    if (reg.error) throw new Error(`register ${s.agentId} failed: ${reg.error.message}`);
  }

  // agent.spawn authorizes its cwd against a registered project root, so each
  // identity opens one. `owner` drives the happy paths; `otherRoot` proves a
  // signer cannot spawn into a root it neither owns nor was granted.
  repoRoot = await mkdtemp(join(tmpdir(), 'revdev-spawn-root-'));
  otherRoot = await mkdtemp(join(tmpdir(), 'revdev-spawn-otherroot-'));
  // project.open now rejects a non-repo root (GAP-326 D1); make the fixtures repos.
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: otherRoot });
  await signedRpc(owner, 'project.open', { repoPath: repoRoot });
  await signedRpc(other, 'project.open', { repoPath: otherRoot });
});

afterAll(async () => {
  await close?.();
  await rm(dataDir, { recursive: true, force: true });
  clearTestLicenseEnv();
  delete process.env.REVDEV_SPAWN_CONFINEMENT;
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
    const resp = await rpcFrame(socketPath, 'agent.spawn', {
      command: 'bash',
      repoPath: repoRoot,
    });
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
      repoPath: repoRoot,
    })) as { processId: string; pid: number };

    expect(result.processId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(typeof result.pid).toBe('number');
    expect(result.pid).toBeGreaterThan(0);
  });

  it('rejects when command is missing (schema validation)', async () => {
    await expect(signedRpc(owner, 'agent.spawn', { repoPath: repoRoot })).rejects.toThrow();
  });

  it('rejects a nonexistent cwd', async () => {
    await expect(
      signedRpc(owner, 'agent.spawn', {
        command: 'bash',
        repoPath: repoRoot,
        cwd: join(repoRoot, 'nonexistent', 'does-not-exist'),
      }),
    ).rejects.toThrow();
  });

  // Under the escape hatch a spawn is unconfined, but it leaves a receipt: the
  // audit row records confinement='none' (spec §8.1).
  it("records confinement='none' on the row under the escape hatch", async () => {
    const { processId } = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      repoPath: repoRoot,
    })) as { processId: string };
    const row = await db.query<{ confinement: string | null }>(
      `SELECT confinement FROM agent_processes WHERE id = $1`,
      [processId],
    );
    expect(row.rows[0]?.confinement).toBe('none');
    // Release the live-count slot — mock ptys never exit on their own, and the
    // per-agent cap (10) is shared across every owner spawn in this file.
    _lastPty?._fireExit(0);
  });

  // The env allow-list (spec §7) runs regardless of confinement mode, so it is
  // enforced even under the escape hatch. A non-allow-listed key is rejected by
  // name (§10 test 3).
  it('rejects a caller env key outside the allow-list', async () => {
    await expect(
      signedRpc(owner, 'agent.spawn', {
        command: 'bash',
        repoPath: repoRoot,
        env: { HOME: '/base/op' },
      }),
    ).rejects.toThrow(/not caller-settable/);
  });

  it('accepts an allow-listed caller env key (TERM)', async () => {
    const result = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      repoPath: repoRoot,
      env: { TERM: 'screen-256color' },
    })) as { processId: string };
    expect(typeof result.processId).toBe('string');
    _lastPty?._fireExit(0);
  });
});

describe('agent.spawn authorization (project grant)', () => {
  it('rejects when repoPath is absent — no implicit $HOME cwd', async () => {
    await expect(signedRpc(owner, 'agent.spawn', { command: 'bash' })).rejects.toThrow();
  });

  it('rejects an unregistered repoPath', async () => {
    const stray = await mkdtemp(join(tmpdir(), 'revdev-spawn-stray-'));
    try {
      await expect(
        signedRpc(owner, 'agent.spawn', { command: 'bash', repoPath: stray }),
      ).rejects.toThrow(/not registered/);
    } finally {
      await rm(stray, { recursive: true, force: true });
    }
  });

  it("rejects spawning into another agent's root", async () => {
    await expect(
      signedRpc(owner, 'agent.spawn', { command: 'bash', repoPath: otherRoot }),
    ).rejects.toThrow(/not registered/);
  });

  it('allows spawning into another agent root once granted, and refuses after revoke', async () => {
    await signedRpc(other, 'project.grant', {
      repoPath: otherRoot,
      granteeAgentId: owner.agentId,
    });

    const granted = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      repoPath: otherRoot,
    })) as { processId: string };
    expect(typeof granted.processId).toBe('string');

    await signedRpc(other, 'project.revoke', {
      repoPath: otherRoot,
      granteeAgentId: owner.agentId,
    });

    await expect(
      signedRpc(owner, 'agent.spawn', { command: 'bash', repoPath: otherRoot }),
    ).rejects.toThrow(/not registered/);
  });

  // `join()` normalizes the `..` away, so this string never contains one: the
  // schema's safePath refinement cannot see it and the HANDLER's within() check
  // is what rejects it. Pinned to that message so it cannot pass for some other
  // reason (e.g. a missing directory).
  it('rejects a cwd that resolves outside the authorized root', async () => {
    await expect(
      signedRpc(owner, 'agent.spawn', {
        command: 'bash',
        repoPath: repoRoot,
        cwd: join(repoRoot, '..'),
      }),
    ).rejects.toThrow(/escapes project root/);
  });

  // The unnormalized form does carry a literal `..`, and is refused earlier, at
  // schema validation. Both layers are exercised.
  it('rejects a literal .. in cwd at the schema boundary', async () => {
    await expect(
      signedRpc(owner, 'agent.spawn', {
        command: 'bash',
        repoPath: repoRoot,
        cwd: `${repoRoot}/../etc`,
      }),
    ).rejects.toThrow(/Invalid params/);
  });

  it('rejects a cwd symlink pointing outside the authorized root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'revdev-spawn-outside-'));
    const link = join(repoRoot, 'escape-link');
    try {
      await symlink(outside, link, 'dir');
      await expect(
        signedRpc(owner, 'agent.spawn', { command: 'bash', repoPath: repoRoot, cwd: link }),
      ).rejects.toThrow(/escapes project root/);
    } finally {
      await rm(link, { force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('accepts a real subdirectory of the authorized root', async () => {
    const sub = join(repoRoot, 'packages', 'nested');
    await mkdir(sub, { recursive: true });
    const result = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      repoPath: repoRoot,
      cwd: sub,
    })) as { processId: string };
    expect(typeof result.processId).toBe('string');
  });
});

describe('agent.input', () => {
  it('writes data to the mocked pty', async () => {
    const { processId } = (await signedRpc(owner, 'agent.spawn', {
      command: 'bash',
      repoPath: repoRoot,
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
      repoPath: repoRoot,
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
      repoPath: repoRoot,
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
      repoPath: repoRoot,
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
      repoPath: repoRoot,
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
      repoPath: repoRoot,
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
      repoPath: repoRoot,
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
      repoPath: repoRoot,
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
