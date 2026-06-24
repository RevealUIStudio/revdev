/**
 * End-to-end test of the Studio zero-9P signing model (ADR P1) against a real
 * daemon over a Unix socket. Proves:
 *   1. session.register with a CLIENT-supplied publicKeyPem registers the
 *      client's key (the returned DID carries the client fingerprint) and the
 *      daemon never mints a keypair.
 *   2. A signature produced with the client private key passes the dispatch
 *      enforcement for a MUTATING_OR_CONTENT_METHODS call (file.write/read).
 *   3. An unsigned content read is rejected -32003.
 *   4. A signature from a DIFFERENT key is rejected -32003.
 *
 * This is also the executable spec for the Rust signing client (P1, Studio
 * side): produce envelopes byte-compatible with what this test sends.
 */

import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
// Side-effect import: registers project.open / file.* / git.* handlers
// (normally wired via index.js, which this test bypasses).
import '../filegit.js';

// PGlite cold-init can take well over the 10s default hook budget under load.
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

/** Sign a request exactly as the Studio client must. */
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

describe('Studio client-key signing (zero-9P P1)', () => {
  let daemon: { close: () => Promise<void> };
  let socketPath: string;
  let dataDir: string;
  let repo: string;
  const agentId = 'studio-signing-test';

  // Client-held keypair — simulates the key Studio keeps in its Windows vault.
  const kp = generateAgentKeypair();
  const fingerprint = computeFingerprint(kp.publicKeyRaw);
  const did = formatDid(agentId, fingerprint);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'revdev-signed-'));
    repo = await mkdtemp(join(tmpdir(), 'revdev-signed-repo-'));
    socketPath = join(dataDir, 'harness.sock');
    // Trust anchor: provision THIS client's fingerprint so enrollment is
    // allowed (the production install writes this root-owned; the test points
    // the daemon at a fixture via trustedClientFingerprintPath).
    const anchor = join(dataDir, 'trusted-client-fingerprint');
    await writeFile(anchor, `# test trust anchor\n${agentId}:${fingerprint}\n`);
    daemon = await startDaemon({
      socketPath,
      dataDir,
      trustedClientFingerprintPath: anchor,
      trustedAnchorRequireRootOwned: false,
    });
  });

  afterAll(async () => {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  it('registers the client public key (DID carries the client fingerprint)', async () => {
    const res = await rpcFrame(socketPath, 'session.register', {
      agentId,
      agentName: 'studio-ui',
      backend: 'studio',
      publicKeyPem: kp.publicKeyPem,
    });
    const result = res.result as { did: string; publicKeyPem: string };
    expect(result.did).toBe(did);
    // The daemon stored the CLIENT key verbatim, not a freshly minted one.
    expect(result.publicKeyPem).toBe(kp.publicKeyPem);
  });

  it('accepts a signed file.write + file.read round-trip with no stale read', async () => {
    // project.open is now signature-REQUIRED — the root is recorded under the
    // verified signer (per-agent root scoping), so it must be signed too.
    const openParams = { repoPath: repo };
    const open = await rpcFrame(
      socketPath,
      'project.open',
      openParams,
      sign('project.open', openParams, did, fingerprint, kp.privateKeyPem),
    );
    expect((open.result as { success: boolean }).success).toBe(true);

    const writeParams = { repoPath: repo, filePath: 'note.txt', content: 'zero-9P round trip' };
    const w = await rpcFrame(
      socketPath,
      'file.write',
      writeParams,
      sign('file.write', writeParams, did, fingerprint, kp.privateKeyPem),
    );
    expect((w.result as { success: boolean }).success).toBe(true);

    const readParams = { repoPath: repo, filePath: 'note.txt' };
    const r = await rpcFrame(
      socketPath,
      'file.read',
      readParams,
      sign('file.read', readParams, did, fingerprint, kp.privateKeyPem),
    );
    expect((r.result as { content: string }).content).toBe('zero-9P round trip');
    // And it actually hit ext4.
    expect(await readFile(join(repo, 'note.txt'), 'utf8')).toBe('zero-9P round trip');
  });

  it('rejects an UNSIGNED content read with -32003', async () => {
    const res = await rpcFrame(socketPath, 'file.read', { repoPath: repo, filePath: 'note.txt' });
    expect(res.error?.code).toBe(-32003);
  });

  it('rejects a content read signed by a DIFFERENT key with -32003', async () => {
    const other = generateAgentKeypair();
    const otherFp = computeFingerprint(other.publicKeyRaw);
    const params = { repoPath: repo, filePath: 'note.txt' };
    // Same did/kid claim, but signed with a key the daemon never registered.
    const res = await rpcFrame(
      socketPath,
      'file.read',
      params,
      sign('file.read', params, did, otherFp, other.privateKeyPem),
    );
    expect(res.error?.code).toBe(-32003);
  });

  it('rejects a signed read of a literal ../ traversal (validation barrier)', async () => {
    // The cheap first barrier: the safePath schema rejects `..` before dispatch.
    const params = { repoPath: repo, filePath: '../../../../etc/passwd' };
    const res = await rpcFrame(
      socketPath,
      'file.read',
      params,
      sign('file.read', params, did, fingerprint, kp.privateKeyPem),
    );
    expect(res.error?.code).toBe(-32602); // Invalid params
    expect(res.result).toBeUndefined();
  });

  it('rejects a signed read through a symlink escaping the root (realpath barrier)', async () => {
    // A symlink passes `..` validation, so this exercises the realpath
    // descendant check in the handler — a key-holder still cannot read outside
    // the registered root.
    const secret = join(dataDir, 'outside-secret.txt');
    await writeFile(secret, 'TOP SECRET');
    await symlink(secret, join(repo, 'link.txt'));
    const params = { repoPath: repo, filePath: 'link.txt' };
    const res = await rpcFrame(
      socketPath,
      'file.read',
      params,
      sign('file.read', params, did, fingerprint, kp.privateKeyPem),
    );
    expect(res.error?.code).toBe(-32000);
    expect(res.error?.message).toContain('escapes project root');
  });

  // ---- Signed-RPC attack matrix (the protections #164 added, now witnessed) ----
  // Each forged/abused envelope must be rejected -32003 by verifyOrWarn before
  // the handler runs. note.txt exists from the round-trip test above.

  it('rejects a REPLAYED envelope (nonce reuse) with -32003', async () => {
    const params = { repoPath: repo, filePath: 'note.txt' };
    // One envelope, fixed nonce. First use must verify; the replay must fail.
    const envelope = sign('file.read', params, did, fingerprint, kp.privateKeyPem);
    const first = await rpcFrame(socketPath, 'file.read', params, envelope);
    expect((first.result as { content: string }).content).toBe('zero-9P round trip');
    const replay = await rpcFrame(socketPath, 'file.read', params, envelope);
    expect(replay.error?.code).toBe(-32003);
    expect(replay.result).toBeUndefined();
  });

  it('rejects a STALE-ts envelope (outside the ±60s window) with -32003', async () => {
    const params = { repoPath: repo, filePath: 'note.txt' };
    // Sign with a timestamp 120s in the past — correctly signed, just expired.
    const stale = serializeEnvelope(
      signEnvelope(
        {
          did,
          kid: fingerprint,
          nonce: generateNonce(),
          ts: Math.floor(Date.now() / 1000) - 120,
          method: 'file.read',
          paramsHash: hashParams('file.read', params),
        },
        kp.privateKeyPem,
      ),
    );
    const res = await rpcFrame(socketPath, 'file.read', params, stale);
    expect(res.error?.code).toBe(-32003);
  });

  it('rejects a paramsHash-MISMATCH envelope (signed for other params) with -32003', async () => {
    // Sign for one filePath, send the envelope on a request for another. The
    // method matches, so this isolates the paramsHash binding.
    const signedFor = { repoPath: repo, filePath: 'note.txt' };
    const sentParams = { repoPath: repo, filePath: 'big.txt' };
    const envelope = sign('file.read', signedFor, did, fingerprint, kp.privateKeyPem);
    const res = await rpcFrame(socketPath, 'file.read', sentParams, envelope);
    expect(res.error?.code).toBe(-32003);
  });

  it('rejects a method-SUBSTITUTION envelope (signed for a different method) with -32003', async () => {
    // A valid envelope minted for file.read, replayed onto a file.delete frame.
    // The signature binds the method, so the substitution is refused (and the
    // file is NOT deleted).
    const params = { repoPath: repo, filePath: 'note.txt' };
    const readEnvelope = sign('file.read', params, did, fingerprint, kp.privateKeyPem);
    const res = await rpcFrame(socketPath, 'file.delete', params, readEnvelope);
    expect(res.error?.code).toBe(-32003);
    expect(await readFile(join(repo, 'note.txt'), 'utf8')).toBe('zero-9P round trip');
  });

  it('rejects an over-long nonce (payload-field bound) with -32003', async () => {
    // A correctly-signed envelope whose nonce breaks the .length(32) bound:
    // SignaturePayloadSchema.safeParse fails in parseEnvelope → unverifiable.
    const params = { repoPath: repo, filePath: 'note.txt' };
    const fat = serializeEnvelope(
      signEnvelope(
        {
          did,
          kid: fingerprint,
          nonce: 'a'.repeat(2048),
          ts: Math.floor(Date.now() / 1000),
          method: 'file.read',
          paramsHash: hashParams('file.read', params),
        },
        kp.privateKeyPem,
      ),
    );
    const res = await rpcFrame(socketPath, 'file.read', params, fat);
    expect(res.error?.code).toBe(-32003);
  });

  it('returns { tooLarge } instead of content above the inline read cap', async () => {
    // Default maxInlineReadBytes is 768 KiB; write past it and confirm the
    // daemon returns the size envelope rather than serializing the whole file.
    const big = 'a'.repeat(800_000);
    await writeFile(join(repo, 'big.txt'), big);
    const params = { repoPath: repo, filePath: 'big.txt' };
    const res = await rpcFrame(
      socketPath,
      'file.read',
      params,
      sign('file.read', params, did, fingerprint, kp.privateKeyPem),
    );
    const result = res.result as { tooLarge?: boolean; bytes?: number; content?: string };
    expect(result.tooLarge).toBe(true);
    expect(result.bytes).toBe(800_000);
    expect(result.content).toBeUndefined();
  });
});
