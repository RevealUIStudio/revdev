/**
 * Security tests for the daemon's signature-enrollment gate + per-agent root
 * scoping (the "make the Ed25519 gate a real barrier" fix). Proves:
 *
 *   1. A client key whose fingerprint is NOT in the root-owned trust anchor is
 *      rejected at session.register (-32004) — both as a fresh self-enrollment
 *      under a new agentId AND as an attempted key-takeover (rotation) of an
 *      already-enrolled agent.
 *   2. A verified signer (agent A) cannot read/mutate a project root that a
 *      different verified signer (agent B) registered via project.open —
 *      registeredRoots is keyed by the opening agentId.
 *
 * Both run against a real daemon over a Unix socket, with the trust anchor
 * pointed at a fixture (production writes it root-owned at install).
 */

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
import { startDaemon } from '../server.js';
// Side-effect import: registers project.open / file.* / git.* handlers.
import '../filegit.js';

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

interface Client {
  agentId: string;
  fingerprint: string;
  did: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

function makeClient(agentId: string): Client {
  const kp = generateAgentKeypair();
  const fingerprint = computeFingerprint(kp.publicKeyRaw);
  return {
    agentId,
    fingerprint,
    did: formatDid(agentId, fingerprint),
    publicKeyPem: kp.publicKeyPem,
    privateKeyPem: kp.privateKeyPem,
  };
}

function sign(c: Client, method: string, params: Record<string, unknown>): string {
  const payload = {
    did: c.did,
    kid: c.fingerprint,
    nonce: generateNonce(),
    ts: Math.floor(Date.now() / 1000),
    method,
    paramsHash: hashParams(method, params),
  };
  return serializeEnvelope(signEnvelope(payload, c.privateKeyPem));
}

describe('daemon enrollment gate + per-agent root scoping', () => {
  let daemon: { close: () => Promise<void> };
  let socketPath: string;
  let dataDir: string;
  let repoA: string;
  let repoB: string;

  // Two PROVISIONED clients (fingerprints written to the anchor) and one
  // UNPROVISIONED attacker key (absent from the anchor).
  const a = makeClient('agent-a');
  const b = makeClient('agent-b');
  const evil = makeClient('agent-evil');

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'revdev-enroll-'));
    repoA = await mkdtemp(join(tmpdir(), 'revdev-enroll-repoA-'));
    repoB = await mkdtemp(join(tmpdir(), 'revdev-enroll-repoB-'));
    socketPath = join(dataDir, 'harness.sock');
    const anchor = join(dataDir, 'trusted-client-fingerprint');
    // Anchor trusts A and B but NOT evil.
    await writeFile(anchor, `${a.fingerprint}\n${b.fingerprint}\n`);
    daemon = await startDaemon({ socketPath, dataDir, trustedClientFingerprintPath: anchor });
  });

  afterAll(async () => {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repoA, { recursive: true, force: true });
    await rm(repoB, { recursive: true, force: true });
  });

  it('enrolls a provisioned client key', async () => {
    const res = await rpcFrame(socketPath, 'session.register', {
      agentId: a.agentId,
      publicKeyPem: a.publicKeyPem,
    });
    expect((res.result as { did: string }).did).toBe(a.did);
    // Register B too (needed for the root-scoping test below).
    const resB = await rpcFrame(socketPath, 'session.register', {
      agentId: b.agentId,
      publicKeyPem: b.publicKeyPem,
    });
    expect((resB.result as { did: string }).did).toBe(b.did);
  });

  it('rejects an UNPROVISIONED client key at register (-32004)', async () => {
    const res = await rpcFrame(socketPath, 'session.register', {
      agentId: evil.agentId,
      publicKeyPem: evil.publicKeyPem,
    });
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe(-32004);
  });

  it('rejects a key-TAKEOVER: enrolling a different key for an existing agent (-32004)', async () => {
    // Attacker tries to supersede agent A's legit key by registering its own
    // (unprovisioned) key under agentId 'agent-a'. Must be refused before the
    // rotation/supersede path runs.
    const res = await rpcFrame(socketPath, 'session.register', {
      agentId: a.agentId,
      publicKeyPem: evil.publicKeyPem,
    });
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe(-32004);

    // A's original key still works end-to-end (the takeover did not supersede).
    const openParams = { repoPath: repoA };
    const open = await rpcFrame(
      socketPath,
      'project.open',
      openParams,
      sign(a, 'project.open', openParams),
    );
    expect((open.result as { success: boolean }).success).toBe(true);
  });

  it('blocks agent A from mutating a root agent B registered', async () => {
    // B opens repoB (signed → recorded under agent-b).
    const openB = { repoPath: repoB };
    const ob = await rpcFrame(socketPath, 'project.open', openB, sign(b, 'project.open', openB));
    expect((ob.result as { success: boolean }).success).toBe(true);

    // A (a valid signer, owns repoA from the previous test) tries to write into
    // repoB. The signature is VALID — the barrier is root ownership, not the
    // signature gate — so it must be refused as not-registered-for-A.
    const writeB = { repoPath: repoB, filePath: 'pwn.txt', content: 'A should not write here' };
    const w = await rpcFrame(socketPath, 'file.write', writeB, sign(a, 'file.write', writeB));
    expect(w.result).toBeUndefined();
    expect(w.error?.message).toContain('not registered');

    // Control: A CAN write into its own repoA.
    const writeA = { repoPath: repoA, filePath: 'ok.txt', content: 'A owns this root' };
    const wa = await rpcFrame(socketPath, 'file.write', writeA, sign(a, 'file.write', writeA));
    expect((wa.result as { success: boolean }).success).toBe(true);
  });
});
