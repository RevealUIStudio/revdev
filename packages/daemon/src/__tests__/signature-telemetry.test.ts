/**
 * P2 signature-status telemetry (ADR 2026-05-16 §Q5).
 *
 * The daemon emits one `identity.signature_status` event per NON-EXEMPT RPC
 * recording whether the call carried a fully-verified Ed25519 signature
 * (`verified` / `none` / `invalid`) and whether the method already hard-requires
 * a signature (`required`). This is observe-only — it must change no accept /
 * reject behavior — and feeds the P3 flip acceptance gate (≥95% signed / 7d).
 *
 * These tests drive a real daemon over a Unix socket and read the emitted rows
 * straight from the events table. The RPC result itself is irrelevant here
 * (some calls are rejected downstream); telemetry is emitted BEFORE any gate,
 * so a rejected call still records its signature status.
 *
 * @vitest-environment node
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
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
// Side-effect import: registers project.open / file.* handlers (file.stat is a
// non-exempt MUTATING_OR_CONTENT method, used here for the required=true cases).
import '../filegit.js';

// PGlite cold-init + key generation can exceed the 10s default hook budget,
// and cold-init is intermittently slow (see project_daemon_pglite_init) — give
// the startup hook generous headroom so a slow-but-healthy init isn't killed.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

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

/** Sign a request exactly as the Studio client must (mirrors filegit-signed). */
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

interface SigEvent {
  agent_id: string;
  payload: { method: string; verification: string; required: boolean };
}

/** The most recent identity.signature_status row, or null if none. */
async function latestSigEvent(db: PGlite): Promise<SigEvent | null> {
  const res = await db.query<SigEvent>(
    `SELECT agent_id, payload FROM events
      WHERE event_type = 'identity.signature_status'
      ORDER BY id DESC LIMIT 1`,
  );
  return res.rows[0] ?? null;
}

async function countSigEvents(db: PGlite): Promise<number> {
  const res = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM events WHERE event_type = 'identity.signature_status'`,
  );
  return res.rows[0]?.n ?? 0;
}

/**
 * Poll until a new identity.signature_status event appears (count > priorCount).
 * Needed for fire-and-forget telemetry cases where the RPC response arrives
 * before PGlite commits the INSERT (e.g. -32003 fast-path rejections).
 */
async function waitForNewSigEvent(db: PGlite, priorCount: number): Promise<SigEvent | null> {
  for (let i = 0; i < 20; i++) {
    const current = await countSigEvents(db);
    if (current > priorCount) return latestSigEvent(db);
    await new Promise<void>((r) => setTimeout(r, 25));
  }
  return null;
}

describe('P2 signature-status telemetry', () => {
  let daemon: { close: () => Promise<void>; _db: PGlite };
  let socketPath: string;
  let dataDir: string;
  let originalLicenseKey: string | undefined;

  const agentId = 'telemetry-test';
  const kp = generateAgentKeypair();
  const fingerprint = computeFingerprint(kp.publicKeyRaw);
  const did = formatDid(agentId, fingerprint);

  // A second, NEVER-registered key — signing with it yields an unknown kid, so
  // verifyOrWarn returns 'invalid'.
  const strangerKp = generateAgentKeypair();
  const strangerFp = computeFingerprint(strangerKp.publicKeyRaw);
  const strangerDid = formatDid(agentId, strangerFp);

  beforeAll(async () => {
    // Some non-exempt methods (tasks.*) are license-gated; a real enterprise key
    // lets those calls reach the telemetry point rather than being rejected by
    // the license guard first.
    const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
    originalLicenseKey = process.env.REVEALUI_LICENSE_KEY;
    setTestLicenseEnv(generateTestLicense('enterprise'));

    dataDir = await mkdtemp(join(tmpdir(), 'revdev-telemetry-'));
    socketPath = join(dataDir, 'harness.sock');
    const anchor = join(dataDir, 'trusted-client-fingerprint');
    await writeFile(anchor, `# test trust anchor\n${agentId}:${fingerprint}\n`);
    daemon = (await startDaemon({
      socketPath,
      dataDir,
      trustedClientFingerprintPath: anchor,
      trustedAnchorRequireRootOwned: false,
    })) as typeof daemon;

    // Enroll the client key so signatures from it verify.
    await rpcFrame(socketPath, 'session.register', {
      agentId,
      agentName: 'telemetry-ui',
      backend: 'studio',
      publicKeyPem: kp.publicKeyPem,
    });
  });

  afterAll(async () => {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
    if (originalLicenseKey === undefined) delete process.env.REVEALUI_LICENSE_KEY;
    else process.env.REVEALUI_LICENSE_KEY = originalLicenseKey;
    const { clearTestLicenseEnv } = await import('./test-license-helper.js');
    clearTestLicenseEnv();
  });

  it('records verification=verified for a validly-signed non-exempt RPC', async () => {
    const params = { repoPath: '/tmp/telemetry-repo', filePath: 'README.md' };
    await rpcFrame(
      socketPath,
      'file.stat',
      params,
      sign('file.stat', params, did, fingerprint, kp.privateKeyPem),
    );
    const ev = await latestSigEvent(daemon._db);
    expect(ev?.payload.method).toBe('file.stat');
    expect(ev?.payload.verification).toBe('verified');
    expect(ev?.payload.required).toBe(true);
  });

  it('records verification=none for an unsigned non-exempt RPC (unbound actor)', async () => {
    const params = { repoPath: '/tmp/telemetry-repo', filePath: 'README.md' };
    // -32003 arrives before the fire-and-forget INSERT commits; poll for it.
    const before = await countSigEvents(daemon._db);
    await rpcFrame(socketPath, 'file.stat', params);
    const ev = await waitForNewSigEvent(daemon._db, before);
    expect(ev?.payload.method).toBe('file.stat');
    expect(ev?.payload.verification).toBe('none');
    expect(ev?.payload.required).toBe(true);
    // No bound identity and no actorAgentId param → the NOT-NULL sentinel.
    expect(ev?.agent_id).toBe('unbound');
  });

  it('records verification=invalid for a signature from an unknown key', async () => {
    const params = { repoPath: '/tmp/telemetry-repo', filePath: 'README.md' };
    const before = await countSigEvents(daemon._db);
    await rpcFrame(
      socketPath,
      'file.stat',
      params,
      sign('file.stat', params, strangerDid, strangerFp, strangerKp.privateKeyPem),
    );
    const ev = await waitForNewSigEvent(daemon._db, before);
    expect(ev?.payload.method).toBe('file.stat');
    expect(ev?.payload.verification).toBe('invalid');
  });

  it('records required=false for a non-exempt method that is not a mutation/content read', async () => {
    await rpcFrame(socketPath, 'tasks.list', { actorAgentId: agentId });
    const ev = await latestSigEvent(daemon._db);
    expect(ev?.payload.method).toBe('tasks.list');
    expect(ev?.payload.required).toBe(false);
  });

  it('emits NO telemetry for an IDENTITY_EXEMPT method (ping)', async () => {
    const before = await countSigEvents(daemon._db);
    await rpcFrame(socketPath, 'ping', {});
    const after = await countSigEvents(daemon._db);
    expect(after).toBe(before);
  });

  it('prune drops stale identity.signature_status rows but keeps fresh ones', async () => {
    const db = daemon._db;
    // Directly seed one stale (40d) and one fresh telemetry row with distinct
    // agent_ids so we can assert each independently, immune to other tests.
    await db.query(
      `INSERT INTO events (agent_id, event_type, payload, created_at)
       VALUES ($1, 'identity.signature_status', '{}'::jsonb, NOW() - INTERVAL '40 days')`,
      ['prune-old-marker'],
    );
    await db.query(
      `INSERT INTO events (agent_id, event_type, payload, created_at)
       VALUES ($1, 'identity.signature_status', '{}'::jsonb, NOW())`,
      ['prune-fresh-marker'],
    );
    // harness.prune is signature-required (GAP-312), so it must be signed.
    // Default hardDeleteDays is 30, so the 40-day row is dropped, fresh kept.
    await rpcFrame(
      socketPath,
      'harness.prune',
      {},
      sign('harness.prune', {}, did, fingerprint, kp.privateKeyPem),
    );
    const remaining = await db.query<{ agent_id: string }>(
      `SELECT agent_id FROM events
        WHERE event_type = 'identity.signature_status'
          AND agent_id IN ('prune-old-marker', 'prune-fresh-marker')`,
    );
    const ids = remaining.rows.map((r) => r.agent_id);
    expect(ids).toContain('prune-fresh-marker');
    expect(ids).not.toContain('prune-old-marker');
  });
});
