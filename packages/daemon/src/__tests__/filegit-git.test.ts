/**
 * End-to-end test of the signed git.* surface against a real git repo over a
 * daemon socket. Covers the stage→commit→log flow Studio drives in P2, and in
 * particular the two fields P2's Tauri contracts depend on:
 *   - git.commit returns the new commit's `sha` / `shortSha`.
 *   - git.log returns a numeric unix `timestamp` per commit.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    socketPath = join(dataDir, 'harness.sock');
    daemon = await startDaemon({ socketPath, dataDir });
    await rpc(socketPath, 'session.register', {
      agentId,
      agentName: 'studio-ui',
      backend: 'studio',
      publicKeyPem: kp.publicKeyPem,
    });
    await rpc(socketPath, 'project.open', { repoPath: repo, actorAgentId: agentId });
  });

  afterAll(async () => {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
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
    // git.log is signature-optional; identity rides actorAgentId.
    const r = await rpc(socketPath, 'git.log', {
      repoPath: repo,
      actorAgentId: agentId,
      limit: 10,
    });
    const commits = r.result?.commits as Array<Record<string, unknown>>;
    expect(commits.length).toBe(1);
    expect(typeof commits[0].timestamp).toBe('number');
    expect(commits[0].timestamp as number).toBeGreaterThan(0);
    expect(commits[0].subject).toBe('initial commit');
  });
});
