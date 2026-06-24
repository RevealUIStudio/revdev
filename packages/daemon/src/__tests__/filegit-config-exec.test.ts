/**
 * Git config-exec hardening regression test (HIGH security fix, the test #171
 * promised but never landed).
 *
 * The WSL daemon shells out to git as its own UID for RPC-driven ops on
 * caller-supplied repos. git turns several config keys + an env var into an
 * arbitrary-command vector (diff.external, filter.<d>.clean/.smudge/.process,
 * textconv, hooks, GIT_EXTERNAL_DIFF). A third-party repo opened in Studio is
 * the payload: a routine "view diff" / "stage file" / branch switch would run
 * attacker code as the daemon UID and could exfil ~/.age-identity/keys.txt.
 *
 * Two layers, both proven here over a real signed socket round-trip:
 *   1. project.open refuses to register a repo whose .git/config carries an
 *      exec-bearing key (diff.external + filter.*.process here).
 *   2. For a repo that passed open, the hardened spawn (env + --no-ext-diff +
 *      core.hooksPath=/dev/null) neutralizes a config/hook exec vector planted
 *      AFTER open — git.diffFile / git.stageFile / git.switchBranch all run the
 *      op successfully while the planted command never fires (sentinel absent).
 */

import { execFile as execFileCb } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { _isExecBearingConfigKeyForTest as isExec } from '../filegit.js';
import { startDaemon } from '../server.js';
// Side-effect import: registers project.open / file.* / git.* handlers.
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

describe('git config-exec hardening (zero-9P security)', () => {
  let daemon: { close: () => Promise<void> };
  let socketPath: string;
  let dataDir: string;
  const agentId = 'config-exec-test';

  // Client-held keypair — simulates the key Studio keeps in its Windows vault.
  const kp = generateAgentKeypair();
  const fingerprint = computeFingerprint(kp.publicKeyRaw);
  const did = formatDid(agentId, fingerprint);

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

  /**
   * Initialize a real git repo with one commit. Returns the repo path. Local
   * identity is set so the daemon's git ops (which run with a pinned, possibly
   * empty GIT_CONFIG_GLOBAL) don't need a global identity.
   */
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

  /** Write an executable shell script that touches `sentinel` then exits 0. */
  async function writeTouchScript(scriptPath: string, sentinel: string): Promise<void> {
    await writeFile(scriptPath, `#!/bin/sh\n: > '${sentinel}'\nexit 0\n`, { mode: 0o755 });
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'revdev-cfgexec-'));
    socketPath = join(dataDir, 'harness.sock');
    // Provision this client's fingerprint into the trust anchor (fixture).
    const anchor = join(dataDir, 'trusted-client-fingerprint');
    await writeFile(anchor, `${fingerprint}\n`);
    daemon = await startDaemon({ socketPath, dataDir, trustedClientFingerprintPath: anchor });

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

  it('refuses project.open on a repo whose .git/config sets exec-bearing keys', async () => {
    const repo = await initRepo('revdev-cfgexec-evilrepo-');
    const sentinel = join(repo, 'OPEN_SENTINEL');
    const script = join(repo, 'payload.sh');
    await writeTouchScript(script, sentinel);
    // Exactly the third-party-repo payload from the bug report.
    await git(repo, ['config', 'diff.external', script]);
    await git(repo, ['config', 'filter.evil.process', script]);

    // project.open is signature-REQUIRED now (records the root under the signer).
    const open = await signedRpc('project.open', { repoPath: repo });
    expect(open.error).toBeDefined();
    expect(open.error?.message).toContain('exec-bearing');

    // And the repo is NOT registered: a follow-up content read is rejected for
    // an unregistered root (not silently served).
    const read = await signedRpc('file.read', { repoPath: repo, filePath: 'f.txt' });
    expect(read.error?.message ?? '').toContain('not registered');

    await rm(repo, { recursive: true, force: true });
  });

  it('neutralizes a post-open diff.external + hook while ops still succeed', async () => {
    const repo = await initRepo('revdev-cfgexec-toctou-');
    await git(repo, ['branch', 'feature']);

    // Open while the repo is clean (passes the exec-key scan).
    // project.open is signature-REQUIRED now (records the root under the signer).
    const open = await signedRpc('project.open', { repoPath: repo });
    expect((open.result as { success: boolean }).success).toBe(true);

    // Now poison: a diff.external command + a post-checkout hook. These are the
    // vectors the hardened spawn must defeat at RUN time (env + --no-ext-diff +
    // core.hooksPath=/dev/null) even though the repo was already registered.
    const diffSentinel = join(repo, 'DIFF_SENTINEL');
    const hookSentinel = join(repo, 'HOOK_SENTINEL');
    const diffScript = join(repo, 'diff-payload.sh');
    await writeTouchScript(diffScript, diffSentinel);
    await git(repo, ['config', 'diff.external', diffScript]);
    await writeTouchScript(join(repo, '.git', 'hooks', 'post-checkout'), hookSentinel);
    // A working-tree change so git.diffFile actually has a diff to render.
    await writeFile(join(repo, 'f.txt'), 'original\nmodified\n');

    // git.diffFile — must return the builtin diff, must NOT run diff.external.
    const diff = await signedRpc('git.diffFile', { repoPath: repo, filePath: 'f.txt' });
    expect((diff.result as { success: boolean }).success).toBe(true);
    expect((diff.result as { diff: string }).diff).toContain('+modified');
    expect(await exists(diffSentinel)).toBe(false);

    // git.stageFile — must succeed; diff.external never fires on add.
    const stage = await signedRpc('git.stageFile', { repoPath: repo, filePath: 'f.txt' });
    expect((stage.result as { success: boolean }).success).toBe(true);
    expect(await exists(diffSentinel)).toBe(false);

    // git.switchBranch — must succeed; the post-checkout hook must NOT run.
    const sw = await signedRpc('git.switchBranch', { repoPath: repo, name: 'feature' });
    expect((sw.result as { success: boolean }).success).toBe(true);
    expect(await exists(hookSentinel)).toBe(false);

    await rm(repo, { recursive: true, force: true });
  });

  it('blocks file.write / file.delete into <root>/.git/** (closes the config-plant route)', async () => {
    const repo = await initRepo('revdev-cfgexec-gitwrite-');
    const open = await signedRpc('project.open', { repoPath: repo });
    expect((open.result as { success: boolean }).success).toBe(true);

    // A signed agent tries to plant a filter driver in .git/config via file.write.
    const w = await signedRpc('file.write', {
      repoPath: repo,
      filePath: '.git/config',
      content: '[filter "evil"]\n\tprocess = touch /tmp/revdev-should-not-run\n',
    });
    expect(w.result).toBeUndefined();
    expect(w.error?.message ?? '').toContain('.git/');
    // The real .git/config was NOT overwritten — still a valid repo config.
    expect(await readFile(join(repo, '.git', 'config'), 'utf8')).not.toContain('filter "evil"');

    // A nested .git/hooks write and a .git internal delete are blocked too.
    const wHook = await signedRpc('file.write', {
      repoPath: repo,
      filePath: '.git/hooks/pre-commit',
      content: '#!/bin/sh\n: > /tmp/revdev-should-not-run\n',
    });
    expect(wHook.error?.message ?? '').toContain('.git/');
    const del = await signedRpc('file.delete', { repoPath: repo, filePath: '.git/HEAD' });
    expect(del.error?.message ?? '').toContain('.git/');
    expect(await exists(join(repo, '.git', 'HEAD'))).toBe(true);

    // A normal in-tree write still works (the block is scoped to .git/).
    const ok = await signedRpc('file.write', {
      repoPath: repo,
      filePath: 'note.txt',
      content: 'hi',
    });
    expect((ok.result as { success: boolean }).success).toBe(true);

    await rm(repo, { recursive: true, force: true });
  });

  it('refuses git.stageFile / git.switchBranch when a filter driver is planted post-open', async () => {
    // The filter.* residual: a content filter cannot be -c-cleared per spawn, so
    // the runtime backstop must REFUSE the op. Plant the filter via `git config`
    // (a non-daemon route, since file.write into .git/ is now blocked above) and
    // prove the clean/smudge driver never fires.
    const repo = await initRepo('revdev-cfgexec-filter-');
    await git(repo, ['branch', 'feature']);
    const open = await signedRpc('project.open', { repoPath: repo });
    expect((open.result as { success: boolean }).success).toBe(true);

    const filterSentinel = join(repo, 'FILTER_SENTINEL');
    const filterScript = join(repo, 'filter-payload.sh');
    await writeFile(filterScript, `#!/bin/sh\n: > '${filterSentinel}'\ncat\n`, { mode: 0o755 });
    await git(repo, ['config', 'filter.evil.clean', filterScript]);
    await git(repo, ['config', 'filter.evil.smudge', filterScript]);
    await writeFile(join(repo, '.gitattributes'), '* filter=evil\n');
    await writeFile(join(repo, 'f.txt'), 'changed\n');

    // git.stageFile (clean) must REFUSE and the filter must NOT fire.
    const stage = await signedRpc('git.stageFile', { repoPath: repo, filePath: 'f.txt' });
    expect(stage.result).toBeUndefined();
    expect(stage.error?.message ?? '').toContain('filter');
    expect(await exists(filterSentinel)).toBe(false);

    // git.switchBranch (checkout → smudge) likewise refuses.
    const sw = await signedRpc('git.switchBranch', { repoPath: repo, name: 'feature' });
    expect(sw.result).toBeUndefined();
    expect(sw.error?.message ?? '').toContain('filter');
    expect(await exists(filterSentinel)).toBe(false);

    await rm(repo, { recursive: true, force: true });
  });

  // Direct unit coverage of the exec-key classifier across the full key matrix
  // the socket tests can't each exercise. Keys arrive lower-cased from
  // `git config --list`; subsection names keep their case but the tail variable
  // is lower-cased (e.g. `url.<U>.insteadof`).
  describe('isExecBearingConfigKey classifier', () => {
    it.each([
      ['diff.external', ''],
      ['core.fsmonitor', ''],
      ['core.sshcommand', ''],
      ['core.pager', ''],
      ['filter.lfs.process', ''],
      ['filter.secret.clean', ''],
      ['filter.secret.smudge', ''],
      ['diff.gpg.textconv', ''],
      ['remote.origin.uploadpack', ''],
      ['remote.origin.receivepack', ''],
      ['url.https://evil/.insteadof', ''],
      ['url.x.pushinsteadof', ''],
      ['alias.danger', '!sh -c "id"'],
    ])('flags %s as exec-bearing', (key, value) => {
      expect(isExec(key, value)).toBe(true);
    });

    it.each([
      ['user.name', 'RevDev'],
      ['user.email', 'x@y.z'],
      ['core.repositoryformatversion', '0'],
      ['core.bare', 'false'],
      ['remote.origin.url', 'https://example/x.git'],
      ['branch.main.remote', 'origin'],
      // A non-shell alias (no leading '!') is an ordinary git alias, not RCE.
      ['alias.co', 'checkout'],
      // A key that merely contains a substring must not match.
      ['diff.externalfoo', ''],
    ])('does not flag %s', (key, value) => {
      expect(isExec(key, value)).toBe(false);
    });
  });
});
