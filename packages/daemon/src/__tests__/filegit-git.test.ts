/**
 * End-to-end test of the signed git.* surface against a real git repo over a
 * daemon socket. Covers the stage→commit→log flow Studio drives in P2, and in
 * particular the two fields P2's Tauri contracts depend on:
 *   - git.commit returns the new commit's `sha` / `shortSha`.
 *   - git.log returns a numeric unix `timestamp` per commit.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import '../filegit.js';
import { startDaemon } from '../server.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

interface RpcResult {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function rpc(
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

describe('signed git.* flow (zero-9P P2)', () => {
  let daemon: { close: () => Promise<void> };
  let socketPath: string;
  let dataDir: string;
  let repo: string;
  const agentId = 'studio-git-test';
  const kp = generateAgentKeypair();
  const fingerprint = computeFingerprint(kp.publicKeyRaw);
  const did = formatDid(agentId, fingerprint);

  const sign = (method: string, params: Record<string, unknown>) =>
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

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'revdev-git-'));
    repo = await mkdtemp(join(tmpdir(), 'revdev-git-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@revealui.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    // Synthetic commits must never consult an operator signing key.
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
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
    await rpc(socketPath, 'session.register', {
      agentId,
      agentName: 'studio-ui',
      backend: 'studio',
      publicKeyPem: kp.publicKeyPem,
    });
    // project.open is signature-REQUIRED now (records the root under the signer).
    const openParams = { repoPath: repo };
    await rpc(socketPath, 'project.open', openParams, sign('project.open', openParams));
  });

  afterAll(async () => {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  const read = (method: string, filePath: string) => {
    const params = { repoPath: repo, filePath };
    return rpc(socketPath, method, params, sign(method, params));
  };
  const gitFixture = (args: string[], input?: string) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      ...(input === undefined ? {} : { input }),
    });

  it('reports an unborn HEAD and absent index as explicit missing sides', async () => {
    for (const method of ['git.readBlobAtHead', 'git.readBlobAtIndex']) {
      const result = await read(method, 'not-yet-created.txt');
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ success: true, missing: true });
    }
  });

  it('stages + commits and returns the new commit SHA', async () => {
    await writeFile(join(repo, 'a.txt'), 'hello\n');
    const stage = { repoPath: repo, filePath: 'a.txt' };
    const s = await rpc(socketPath, 'git.stageFile', stage, sign('git.stageFile', stage));
    expect(s.result?.success).toBe(true);

    const commitParams = { repoPath: repo, message: 'initial commit' };
    const c = await rpc(socketPath, 'git.commit', commitParams, sign('git.commit', commitParams));
    expect(c.result?.success).toBe(true);
    expect(typeof c.result?.sha).toBe('string');
    expect((c.result?.sha as string).length).toBe(40);
    expect((c.result?.shortSha as string).length).toBe(7);
  });

  it('git.log returns a numeric unix timestamp per commit', async () => {
    // git.log is signature-REQUIRED now (scoped to the verified signer — B-1).
    const logParams = { repoPath: repo, limit: 10 };
    const r = await rpc(socketPath, 'git.log', logParams, sign('git.log', logParams));
    const commits = r.result?.commits as Array<Record<string, unknown>>;
    expect(commits.length).toBe(1);
    const first = commits[0] as Record<string, unknown>;
    expect(typeof first.timestamp).toBe('number');
    expect(first.timestamp as number).toBeGreaterThan(0);
    expect(first.subject).toBe('initial commit');
  });
  it('preserves committed and indexed final whitespace', async () => {
    for (const method of ['git.readBlobAtHead', 'git.readBlobAtIndex']) {
      expect((await read(method, 'a.txt')).result).toEqual({
        success: true,
        content: 'hello\n',
        bytes: 6,
      });
      expect((await read(method, 'absent.txt')).result).toEqual({ success: true, missing: true });
    }
  });

  it('uses literal pathspecs for Unicode, tabs, newlines and wildcard file names', async () => {
    const name = 'literal[?]*€\t\n.txt';
    const content = '😀 € \n\n';
    await writeFile(join(repo, name), content);
    gitFixture(['--literal-pathspecs', 'add', '--', name]);
    expect((await read('git.readBlobAtIndex', name)).result).toEqual({
      success: true,
      content,
      bytes: Buffer.byteLength(content),
    });
    expect((await read('git.diffContent', name)).result).toEqual({
      success: true,
      content,
      bytes: Buffer.byteLength(content),
    });
  });

  it('distinguishes a present empty blob from a staged deletion', async () => {
    await writeFile(join(repo, 'empty.txt'), '');
    gitFixture(['add', '--', 'empty.txt']);
    for (const method of ['git.readBlobAtIndex', 'git.diffContent']) {
      expect((await read(method, 'empty.txt')).result).toEqual({
        success: true,
        content: '',
        bytes: 0,
      });
    }
    gitFixture(['rm', '--cached', '--', 'a.txt']);
    try {
      expect((await read('git.readBlobAtHead', 'a.txt')).result).toEqual({
        success: true,
        content: 'hello\n',
        bytes: 6,
      });
      expect((await read('git.readBlobAtIndex', 'a.txt')).result).toEqual({
        success: true,
        missing: true,
      });
    } finally {
      gitFixture(['add', '--', 'a.txt']);
    }
  });

  it('distinguishes tracked worktree deletion from arbitrary absent requests', async () => {
    await rm(join(repo, 'a.txt'));
    try {
      expect((await read('git.diffContent', 'a.txt')).result).toEqual({
        success: true,
        missing: true,
      });
      expect((await read('git.diffContent', 'absent-untracked.txt')).error).toBeDefined();
    } finally {
      await writeFile(join(repo, 'a.txt'), 'hello\n');
    }
  });

  it('preserves working-tree read failures and broken symlink errors', async () => {
    await mkdir(join(repo, 'directory.txt'));
    expect((await read('git.diffContent', 'directory.txt')).error).toBeDefined();
    await symlink(join(dataDir, 'nonexistent-target'), join(repo, 'broken-link.txt'));
    gitFixture(['add', '--', 'broken-link.txt']);
    expect((await read('git.diffContent', 'broken-link.txt')).error).toBeDefined();
  });

  it('does not treat escaped or dangling directory links as tracked deletion', async () => {
    const directory = join(repo, 'replaced-directory');
    await mkdir(directory);
    for (const name of ['present.txt', 'missing.txt'])
      await writeFile(join(directory, name), 'tracked\n');
    gitFixture(['add', '--', 'replaced-directory']);
    await rm(directory, { recursive: true });
    await writeFile(join(dataDir, 'present.txt'), 'outside synthetic bytes\n');
    await symlink(dataDir, directory);
    for (const name of ['present.txt', 'missing.txt']) {
      expect((await read('git.diffContent', `replaced-directory/${name}`)).error).toBeDefined();
    }
    await rm(directory);
    await symlink(join(dataDir, 'missing-directory'), directory);
    expect((await read('git.diffContent', 'replaced-directory/missing.txt')).error).toBeDefined();
    await rm(directory);
    // A genuinely removed in-root parent remains a legitimate tracked deletion.
    expect((await read('git.diffContent', 'replaced-directory/missing.txt')).result).toEqual({
      success: true,
      missing: true,
    });
  });

  it('refuses absent and present reads without authenticated root authority', async () => {
    for (const method of ['git.readBlobAtHead', 'git.readBlobAtIndex', 'git.diffContent']) {
      for (const filePath of ['a.txt', 'absent.txt']) {
        expect((await rpc(socketPath, method, { repoPath: repo, filePath })).error).toBeDefined();
        const params = { repoPath: dataDir, filePath };
        expect((await rpc(socketPath, method, params, sign(method, params))).error).toBeDefined();
      }
    }
  });

  it('reports oversized HEAD, index and worktree content explicitly', async () => {
    const content = 'x'.repeat(768 * 1024 + 1);
    await writeFile(join(repo, 'large.txt'), content);
    gitFixture(['add', '--', 'large.txt']);
    gitFixture(['commit', '-m', 'synthetic large diff fixture']);
    for (const method of ['git.readBlobAtHead', 'git.readBlobAtIndex', 'git.diffContent']) {
      expect((await read(method, 'large.txt')).result).toEqual({
        success: true,
        tooLarge: true,
        bytes: content.length,
      });
    }
  });

  it('reports an invalid HEAD as failure rather than an unborn branch', async () => {
    const path = join(repo, '.git/HEAD');
    const original = await readFile(path);
    await writeFile(path, 'invalid HEAD fixture\n');
    try {
      const result = (await read('git.readBlobAtHead', 'a.txt')).result;
      expect(result?.success).toBe(false);
      expect(result?.missing).toBeUndefined();
    } finally {
      await writeFile(path, original);
    }
  });

  it('reports an unmerged index instead of an empty side', async () => {
    const first = gitFixture(['hash-object', '-w', '--stdin'], 'first\n').trim();
    const second = gitFixture(['hash-object', '-w', '--stdin'], 'second\n').trim();
    gitFixture(
      ['update-index', '--index-info'],
      `100644 ${first} 1\tunmerged.txt\n100644 ${second} 2\tunmerged.txt\n`,
    );
    const result = (await read('git.readBlobAtIndex', 'unmerged.txt')).result;
    expect(result?.success).toBe(false);
    expect(result?.error).toContain('Unmerged');
  });

  it('reports a missing indexed object as failure, never missing entry', async () => {
    await writeFile(join(repo, 'broken-object.txt'), 'unique synthetic missing blob object\n');
    gitFixture(['add', '--', 'broken-object.txt']);
    const oid = gitFixture(['rev-parse', ':broken-object.txt']).trim();
    await rm(join(repo, '.git/objects', oid.slice(0, 2), oid.slice(2)));
    const result = (await read('git.readBlobAtIndex', 'broken-object.txt')).result;
    expect(result?.success).toBe(false);
    expect(result?.missing).toBeUndefined();
  });
});
