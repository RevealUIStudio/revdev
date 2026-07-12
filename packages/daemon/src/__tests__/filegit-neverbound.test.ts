/**
 * GAP-326 — file.* never-bound reachability, END-TO-END over a real signed
 * socket (the prove-red attack + the registration/resolution refusals it must
 * produce, plus a legit-repo regression control).
 *
 * The attack (gap description): a client-owned, verified signer project.open's a
 * secret-bearing tree, then file.read's a secret inside it — no spawn, so the
 * confinement never-bound guard never runs. This suite drives that attack
 * through the daemon and proves it is refused at project.open (D1). The daemon
 * data directory is itself a never-bound entry (it holds the integrity DB, the
 * socket, the per-agent homes), so a git repo placed INSIDE dataDir is a
 * self-contained secret-bearing tree that needs no real operator secret to
 * exercise the guard. Reverting the source (confinement.ts + filegit.ts) makes
 * both refusals disappear (project.open succeeds, the secret reads back) — that
 * is the red-first proof this file carries. It uses ONLY the real RPC handlers,
 * no @internal seams, so it runs unchanged against the pre-fix daemon.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDid } from '@revdev/protocol/did';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  computeFingerprint,
  generateAgentKeypair,
  generateNonce,
  hashParams,
  serializeEnvelope,
  signEnvelope,
} from '../agent-identity-crypto.js';
import { startDaemon } from '../server.js';
// Side-effect import: registers project.open / file.* / git.* handlers.
import '../filegit.js';

// PGlite cold-init can exceed the 10s default hook budget under load.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

describe('GAP-326 file-layer never-bound reachability (end-to-end)', () => {
  let daemon: { close: () => Promise<void> };
  let socketPath: string;
  let dataDir: string;
  const agentId = 'gap326-e2e';

  const kp = generateAgentKeypair();
  const fingerprint = computeFingerprint(kp.publicKeyRaw);
  const did = formatDid(agentId, fingerprint);

  function sign(method: string, params: Record<string, unknown>): string {
    const payload = {
      did,
      kid: fingerprint,
      nonce: generateNonce(),
      ts: Math.floor(Date.now() / 1000),
      method,
      paramsHash: hashParams(method, params),
    };
    return serializeEnvelope(signEnvelope(payload, kp.privateKeyPem));
  }

  function signedRpc(method: string, params: Record<string, unknown>): Promise<RpcResult> {
    return rpcFrame(socketPath, method, params, sign(method, params));
  }

  /** git-init a directory so it passes the D1 non-repo check. */
  function gitInit(dir: string): void {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@revdev.local'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'RevDev Test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'revdev-gap326-'));
    socketPath = join(dataDir, 'harness.sock');
    const anchor = join(dataDir, 'trusted-client-fingerprint');
    await writeFile(anchor, `${agentId}:${fingerprint}\n`);
    daemon = await startDaemon({
      socketPath,
      dataDir,
      trustedClientFingerprintPath: anchor,
      trustedAnchorRequireRootOwned: false,
    });
    const reg = await rpcFrame(socketPath, 'session.register', {
      agentId,
      agentName: 'studio-ui',
      backend: 'studio',
      publicKeyPem: kp.publicKeyPem,
    });
    expect((reg.result as { did: string }).did).toBe(did);
  });

  afterAll(async () => {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('REFUSES the never-bound attack: project.open a secret-bearing tree, then read a secret inside (prove-red)', async () => {
    // The daemon data dir is a never-bound entry. A git repo placed inside it is
    // a secret-bearing tree with no real operator secret involved.
    const secretRepo = join(dataDir, 'secret-repo');
    execFileSync('mkdir', ['-p', secretRepo]);
    gitInit(secretRepo);
    // A stand-in for ~/.ssh/id_ed25519 — the thing the attack wants to read.
    await writeFile(join(secretRepo, 'id_ed25519'), 'PRIVATE-KEY-MATERIAL\n');

    // D1: project.open must refuse a root that overlaps the never-bound set.
    // (pre-fix: this SUCCEEDS — the attack's first step works.)
    const open = await signedRpc('project.open', { repoPath: secretRepo });
    expect(open.error).toBeDefined();
    expect(open.error?.message ?? '').toContain('never-bound secret path');
    // The class is named, the full secret path is NOT echoed back to the caller.
    expect(open.error?.message ?? '').not.toContain('id_ed25519');

    // The secret is therefore unreadable: the root was never registered.
    // (pre-fix: project.open registered it and this returns the key material.)
    const read = await signedRpc('file.read', { repoPath: secretRepo, filePath: 'id_ed25519' });
    expect((read.result as { content?: string })?.content).toBeUndefined();
    expect(read.error?.message ?? '').toContain('not registered');
  });

  it('REFUSES a non-repo root at project.open (makes the drifted comment true)', async () => {
    // (pre-fix: registering a bare directory SUCCEEDED — file.* over an arbitrary
    // tree.)
    const bare = await mkdtemp(join(tmpdir(), 'revdev-gap326-bare-'));
    try {
      const open = await signedRpc('project.open', { repoPath: bare });
      expect(open.error).toBeDefined();
      expect(open.error?.message ?? '').toContain('not a git repository');
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('leaves a legit repo root unaffected: open + file.write/read + git.status all succeed (regression)', async () => {
    // A normal project root (a sibling of dataDir under /tmp, not overlapping any
    // never-bound entry) must behave exactly as before.
    const legit = await mkdtemp(join(tmpdir(), 'revdev-gap326-legit-'));
    try {
      gitInit(legit);
      const open = await signedRpc('project.open', { repoPath: legit });
      expect((open.result as { success: boolean }).success).toBe(true);

      const w = await signedRpc('file.write', {
        repoPath: legit,
        filePath: 'note.txt',
        content: 'hello',
      });
      expect((w.result as { success: boolean }).success).toBe(true);

      const r = await signedRpc('file.read', { repoPath: legit, filePath: 'note.txt' });
      expect((r.result as { content: string }).content).toBe('hello');
      // And it actually hit ext4.
      expect(await readFile(join(legit, 'note.txt'), 'utf8')).toBe('hello');

      const st = await signedRpc('git.status', { repoPath: legit });
      expect((st.result as { success: boolean }).success).toBe(true);
    } finally {
      await rm(legit, { recursive: true, force: true });
    }
  });
});
