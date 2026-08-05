/**
 * GAP-309 — end-to-end: signed file.write over the Unix socket enforces
 * formatting without any Claude hook in the loop.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { FORMAT_REJECTED_CODE } from '../format-enforce.js';
import { startDaemon } from '../server.js';
// Side-effect: register project.open / file.* handlers.
import '../filegit.js';

vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = join(here, '..', '..', '..', '..');
const biomeBinDir = join(monorepoRoot, 'node_modules', '.bin');

const MINIMAL_BIOME_JSON = `{
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineEnding": "lf"
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "always"
    }
  }
}
`;

interface RpcResult {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
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
    sock.setTimeout(10_000, () => {
      sock.destroy();
      reject(new Error(`rpc timeout: ${method}`));
    });
  });
}

function sign(
  method: string,
  params: Record<string, unknown>,
  did: string,
  fingerprint: string,
  privateKeyPem: string,
): string {
  const payload = {
    did,
    kid: fingerprint,
    nonce: generateNonce(),
    ts: Math.floor(Date.now() / 1000),
    method,
    paramsHash: hashParams(method, params),
  };
  return serializeEnvelope(signEnvelope(payload, privateKeyPem));
}

describe('file.write format enforcement (GAP-309 e2e)', () => {
  let daemon: { close: () => Promise<void> };
  let socketPath: string;
  let dataDir: string;
  let repo: string;
  const agentId = 'format-enforce-test';
  const kp = generateAgentKeypair();
  const fingerprint = computeFingerprint(kp.publicKeyRaw);
  const did = formatDid(agentId, fingerprint);
  let prevPath: string | undefined;

  beforeAll(async () => {
    prevPath = process.env.PATH;
    process.env.PATH = `${biomeBinDir}:${process.env.PATH ?? ''}`;

    dataDir = await mkdtemp(join(tmpdir(), 'revdev-fmt-e2e-'));
    repo = await mkdtemp(join(tmpdir(), 'revdev-fmt-repo-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await writeFile(join(repo, 'biome.json'), MINIMAL_BIOME_JSON);
    await mkdir(join(repo, 'src'), { recursive: true });

    socketPath = join(dataDir, 'harness.sock');
    const anchor = join(dataDir, 'trusted-client-fingerprint');
    await writeFile(anchor, `# test trust anchor\n${agentId}:${fingerprint}\n`);
    daemon = await startDaemon({
      socketPath,
      dataDir,
      trustedClientFingerprintPath: anchor,
      trustedAnchorRequireRootOwned: false,
    });

    // Register + open project once for the suite.
    const reg = await rpcFrame(socketPath, 'session.register', {
      agentId,
      agentName: 'format-test',
      backend: 'test',
      publicKeyPem: kp.publicKeyPem,
    });
    expect(reg.error).toBeUndefined();

    const openParams = { repoPath: repo };
    const open = await rpcFrame(
      socketPath,
      'project.open',
      openParams,
      sign('project.open', openParams, did, fingerprint, kp.privateKeyPem),
    );
    expect((open.result as { success: boolean }).success).toBe(true);
  });

  afterAll(async () => {
    process.env.PATH = prevPath;
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  it('rejects unformatted content with -32007 and does not write the file', async () => {
    const writeParams = {
      repoPath: repo,
      filePath: 'src/unformatted.ts',
      content: 'const  x =1',
    };
    const w = await rpcFrame(
      socketPath,
      'file.write',
      writeParams,
      sign('file.write', writeParams, did, fingerprint, kp.privateKeyPem),
    );
    expect(w.error?.code).toBe(FORMAT_REJECTED_CODE);
    expect(w.error?.message).toMatch(/not formatted|biome/i);
    expect(w.error?.data).toMatchObject({
      kind: 'format-rejected',
      formatter: 'biome',
    });
    // File must not exist on disk (check-and-reject, never write then revert).
    await expect(readFile(join(repo, 'src', 'unformatted.ts'), 'utf8')).rejects.toThrow();
  });

  it('accepts formatted content and writes it through', async () => {
    const formatted = execFileSync(
      join(biomeBinDir, 'biome'),
      ['format', '--stdin-file-path', 'src/ok.ts'],
      {
        cwd: repo,
        input: 'const x = 1;\n',
        encoding: 'utf8',
      },
    );
    const writeParams = {
      repoPath: repo,
      filePath: 'src/ok.ts',
      content: formatted,
    };
    const w = await rpcFrame(
      socketPath,
      'file.write',
      writeParams,
      sign('file.write', writeParams, did, fingerprint, kp.privateKeyPem),
    );
    expect(w.error).toBeUndefined();
    expect((w.result as { success: boolean }).success).toBe(true);
    expect(await readFile(join(repo, 'src', 'ok.ts'), 'utf8')).toBe(formatted);
  });

  it('does not enforce on paths outside the formatter domain', async () => {
    const writeParams = {
      repoPath: repo,
      filePath: 'notes.txt',
      content: 'any  mess   is fine',
    };
    const w = await rpcFrame(
      socketPath,
      'file.write',
      writeParams,
      sign('file.write', writeParams, did, fingerprint, kp.privateKeyPem),
    );
    expect(w.error).toBeUndefined();
    expect((w.result as { success: boolean }).success).toBe(true);
  });
});
