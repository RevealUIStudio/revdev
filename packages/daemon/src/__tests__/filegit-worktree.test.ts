/**
 * worktree.* signature-gate + confinement regression test (B-WT, HIGH).
 *
 * Before this fix `worktree.create` / `worktree.remove` lived in vcs.ts, absent
 * from the dispatch signature gate (MUTATING_OR_CONTENT_METHODS) AND with no
 * requireRoot / assertNoFilterDriver. An UNSIGNED host process could
 * session.register a bare identity and drive `git worktree add` as the daemon
 * UID against an attacker-controlled base repo — a filter.* driver on that base
 * then ran arbitrary code as the daemon UID on the checkout (unsigned daemon-UID
 * RCE). The fix moves both handlers into filegit.ts behind the same barriers as
 * file.* / git.*, and adds them to the signature gate.
 *
 * worktree.* is Pro-gated (multi-agent coordination), so the test runs the
 * daemon under a Pro license — the license guard is NOT a security barrier
 * against this threat (a host process can set REVEALUI_LICENSE_KEY); the
 * signature gate is. With the license satisfied, the signature gate is the
 * barrier actually exercised below.
 *
 * Everything here is proven over a real signed socket round-trip (mirrors
 * filegit-config-exec.test.ts / filegit-enrollment.test.ts):
 *   (a) an UNSIGNED worktree.create / worktree.remove is rejected with -32003.
 *   (b) a signed worktree.create against a base repo carrying a filter.* driver
 *       is REFUSED and the driver never fires.
 *   (c) a signed worktree.create on a project.open'd base SUCCEEDS, materializes
 *       the worktree at the deterministic sibling path, ignores a malicious
 *       params.path, and worktree.remove cleans it up.
 *   (d) a signed worktree.create on a root the caller never project.open'd is
 *       refused (per-agent ownership), and an option-injecting branch is rejected.
 */

import { execFile as execFileCb } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
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
import {
  clearTestLicenseEnv,
  generateTestLicense,
  setTestLicenseEnv,
} from './test-license-helper.js';
// Side-effect import: registers project.open / file.* / git.* / worktree.* handlers.
import '../filegit.js';

const execFile = promisify(execFileCb);

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

/** True if a path exists on disk. */
async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

describe('worktree.* signature gate + confinement (B-WT)', () => {
  let daemon: { close: () => Promise<void> };
  let socketPath: string;
  let dataDir: string;
  const agentId = 'worktree-test';

  // Client-held keypair — simulates the key Studio keeps in its Windows vault.
  const kp = generateAgentKeypair();
  const fingerprint = computeFingerprint(kp.publicKeyRaw);
  const did = formatDid(agentId, fingerprint);

  // (c) sanity: the test depends on signEnvelope being a real export of
  // agent-identity-crypto.ts (the prior draft guessed and silently no-op'd).
  it('signEnvelope is a real export used for the signed round-trip', () => {
    expect(typeof signEnvelope).toBe('function');
  });

  /** Sign a request exactly as the Studio client must. */
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

  /** Signed RPC convenience wrapper for MUTATING_OR_CONTENT_METHODS. */
  function signedRpc(method: string, params: Record<string, unknown>): Promise<RpcResult> {
    return rpcFrame(socketPath, method, params, sign(method, params));
  }

  const git = (repo: string, args: string[]) => execFile('git', args, { cwd: repo });

  /** Initialize a real git repo with one commit on `main`. */
  async function initRepo(prefix: string): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), prefix));
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'test@revdev.local']);
    await git(repo, ['config', 'user.name', 'RevDev Test']);
    await git(repo, ['config', 'commit.gpgsign', 'false']);
    await writeFile(join(repo, 'f.txt'), 'original\n');
    await git(repo, ['add', 'f.txt']);
    await git(repo, ['commit', '-qm', 'init']);
    return repo;
  }

  beforeAll(async () => {
    // worktree.* is Pro-gated; provision a Pro license BEFORE startDaemon so the
    // license guard passes and the SIGNATURE gate is the barrier under test.
    setTestLicenseEnv(generateTestLicense('pro'));
    dataDir = await mkdtemp(join(tmpdir(), 'revdev-worktree-'));
    socketPath = join(dataDir, 'harness.sock');
    // Provision this client's fingerprint into the trust anchor (fixture).
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
    clearTestLicenseEnv();
  });

  // (a) The core of B-WT: the dispatch sig-gate now covers worktree.*.
  it('rejects an UNSIGNED worktree.create / worktree.remove with -32003', async () => {
    const repo = await initRepo('revdev-wt-unsigned-');
    const create = await rpcFrame(socketPath, 'worktree.create', {
      repoPath: repo,
      branch: 'feature/x',
    });
    expect(create.error?.code).toBe(-32003);
    const remove = await rpcFrame(socketPath, 'worktree.remove', {
      repoPath: repo,
      branch: 'feature/x',
    });
    expect(remove.error?.code).toBe(-32003);
    await rm(repo, { recursive: true, force: true });
  });

  // (b) Real assertNoFilterDriver refusal over a signed socket — NOT the
  // _isExecBearingConfigKeyForTest classifier the prior draft asserted.
  it('refuses a signed worktree.create whose base repo carries a filter driver', async () => {
    const repo = await initRepo('revdev-wt-filter-');
    // Open while clean (passes the exec-key scan at project.open).
    const open = await signedRpc('project.open', { repoPath: repo });
    expect((open.result as { success: boolean }).success).toBe(true);

    // Plant a content filter via `git config` (a non-daemon route, since
    // file.write into .git/ is blocked) + a .gitattributes that routes the
    // tree through it. The checkout `git worktree add` performs would fire it.
    const sentinel = join(repo, 'WT_FILTER_SENTINEL');
    const script = join(repo, 'filter-payload.sh');
    await writeFile(script, `#!/bin/sh\n: > '${sentinel}'\ncat\n`, { mode: 0o755 });
    await git(repo, ['config', 'filter.evil.process', script]);
    await git(repo, ['config', 'filter.evil.clean', script]);
    await git(repo, ['config', 'filter.evil.smudge', script]);
    await writeFile(join(repo, '.gitattributes'), '* filter=evil\n');

    const wt = await signedRpc('worktree.create', { repoPath: repo, branch: 'feature/x' });
    expect(wt.result).toBeUndefined();
    expect(wt.error?.message ?? '').toContain('filter');
    // The driver never ran, and no worktree was materialized.
    expect(await exists(sentinel)).toBe(false);

    await rm(repo, { recursive: true, force: true });
  });

  // (c) Signed round-trip: success at the deterministic path, attacker path
  // ignored, then remove cleans up.
  it('signed worktree.create materializes the deterministic sibling path and remove cleans up', async () => {
    const repo = await initRepo('revdev-wt-ok-');
    const open = await signedRpc('project.open', { repoPath: repo });
    const root = (open.result as { success: boolean; root: string }).root;
    expect((open.result as { success: boolean }).success).toBe(true);

    // A malicious params.path must be IGNORED — the path is daemon-derived.
    const attackerPath = join(tmpdir(), `revdev-wt-attacker-${process.pid}`);
    const wt = await signedRpc('worktree.create', {
      repoPath: repo,
      branch: 'feature/x',
      path: attackerPath,
    });
    const expectedPath = join(dirname(root), `${basename(root)}-feature-x`);
    expect((wt.result as { success: boolean }).success).toBe(true);
    expect((wt.result as { worktreePath: string }).worktreePath).toBe(expectedPath);
    expect(await exists(expectedPath)).toBe(true);
    expect(await exists(join(expectedPath, '.git'))).toBe(true);
    // The attacker-supplied path was not used.
    expect(await exists(attackerPath)).toBe(false);

    const rmw = await signedRpc('worktree.remove', { repoPath: repo, branch: 'feature/x' });
    expect((rmw.result as { success: boolean }).success).toBe(true);
    expect(await exists(expectedPath)).toBe(false);

    await rm(repo, { recursive: true, force: true });
    await rm(expectedPath, { recursive: true, force: true });
    await rm(attackerPath, { recursive: true, force: true });
  });

  // (d) requireRoot per-agent ownership + option-injection guard.
  it('refuses worktree.create on a root the caller never opened, and an option-injecting branch', async () => {
    const repo = await initRepo('revdev-wt-guard-');

    // No project.open → not registered under this agent.
    const unowned = await signedRpc('worktree.create', { repoPath: repo, branch: 'feature/x' });
    expect(unowned.result).toBeUndefined();
    expect(unowned.error?.message ?? '').toContain('not registered');

    // Open it, then try a branch name that would be read as a git option.
    const open = await signedRpc('project.open', { repoPath: repo });
    expect((open.result as { success: boolean }).success).toBe(true);
    const inj = await signedRpc('worktree.create', {
      repoPath: repo,
      branch: '--upload-pack=touch /tmp/revdev-should-not-run',
    });
    expect(inj.result).toBeUndefined();
    expect(inj.error?.message ?? '').toContain('option injection');

    await rm(repo, { recursive: true, force: true });
  });
});
