/**
 * Daemon RPC server — listens on Unix socket, dispatches JSON-RPC 2.0 calls.
 *
 * The server initializes PGlite, runs schema migrations, then accepts
 * newline-delimited JSON-RPC requests over the socket. Each request is
 * checked against the license guard before dispatch.
 *
 * Identity model:
 *   Each connected socket has a SocketContext. A client calls
 *   `session.register` to obtain a sessionId, which is then bound to
 *   the socket as `ctx.agentId`. All subsequent coordination calls
 *   (mail.*, files.*, tasks.*, memory.*, events.log) use ctx.agentId
 *   as the caller identity. This lets two agents on the same daemon
 *   be distinguishable. Calls that require identity but arrive before
 *   `session.register` are rejected with -32002.
 */

import { mkdir } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { formatDid, parseDid } from '@revdev/protocol/did';
import { createLogger } from '@revealui/utils/logger';
import {
  computeFingerprint,
  generateAgentKeypair,
  hashParams,
  parseEnvelope,
  verifyEnvelope,
} from './agent-identity-crypto.js';
import { DAEMON_DEFAULTS, type DaemonConfig } from './config.js';
import {
  guardRpcMethod,
  initLicenseGuard,
  licenseErrorResponse,
  runtimeLicenseRecheck,
} from './guard.js';
import {
  initNeonSync,
  isNeonSyncActive,
  listFleetSessions,
  syncEventLog,
  syncFilesRelease,
  syncFilesReserve,
  syncMailBroadcast,
  syncMailMarkRead,
  syncMailSend,
  syncSessionEnd,
  syncSessionRegister,
  syncSessionUpdate,
  syncTaskClaim,
  syncTaskComplete,
  syncTaskCreate,
  syncTaskRelease,
} from './neon.js';
import { initObservability, onConnect, onDisconnect, trackRpcCall } from './observability.js';
import { revvaultSet } from './revvault-client.js';
import { migrate } from './storage/migrate.js';
import { invalidParamsResponse, validateParams } from './validation/index.js';

const log = createLogger({ service: 'revdev-daemon' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
  'x-revdev-signature'?: string;
}

/** Per-connection state. Populated on session.register or session.attach. */
export interface SocketContext {
  /** Agent identity for this socket. Null until session.register/attach succeeds. */
  agentId: string | null;
  /** Human-readable agent name (e.g. "claude-main"). */
  agentName: string | null;
  /**
   * How `agentId` was bound to this socket:
   *   - 'register'/'attach': long-lived identity (trigger cleanup on disconnect)
   *   - 'param': transient actorAgentId from a fresh-per-call client (never cleanup)
   *   - 'signature': bound via a verified Ed25519 envelope (never cleanup)
   *   - null: unbound
   */
  boundVia: 'register' | 'attach' | 'param' | 'signature' | null;
  /** Set when a request was authenticated via a verified Ed25519 envelope. */
  verifiedSignature: { kid: string; nonce: string } | null;
  // Pre-signature snapshot — captured before signature overrides identity,
  // restored on the next request that arrives unsigned (or with a different
  // signature). Prevents a signed-then-unsigned reuse from inheriting the
  // signed identity on the same socket. See Codex P1 finding on PR #61.
  preSignatureAgentId: string | null;
  preSignatureAgentName: string | null;
  preSignatureBoundVia: 'register' | 'attach' | 'param' | null;
}

type RpcHandler = (
  params: Record<string, unknown>,
  db: PGlite,
  ctx: SocketContext,
) => Promise<unknown>;

/** Methods that can be called without a registered session identity. */
const IDENTITY_EXEMPT = new Set([
  'ping',
  'session.register',
  'session.attach',
  'session.list',
  'harness.health',
  'harness.prune',
  'inference.status',
  'inference.pull',
  'inference.start',
  'inference.stop',
  'inference.chat',
  'inference.generate',
]);

// ---------------------------------------------------------------------------
// Stale-session pruning state (GAP-153)
//
// Module-level by design — each daemon process is a singleton, so a single
// state object suffices. The integration test suite at coordination.test.ts
// runs daemons sequentially, not concurrently, so cross-test contamination
// is not a concern. If the test pattern ever changes to spawn concurrent
// daemons in the same process, this needs to become a per-db Map.
// ---------------------------------------------------------------------------

interface PruneState {
  lastRunAt: Date | null;
  lastAgedCount: number;
  lastDeletedCount: number;
}

const pruneState: PruneState = {
  lastRunAt: null,
  lastAgedCount: 0,
  lastDeletedCount: 0,
};

/**
 * Run a single prune pass against the daemon database.
 *
 * Two-phase cleanup:
 *   1. Sessions older than `staleDays` with no `ended_at` are marked ended
 *      with `exit_summary = 'pruned-stale'`. Models cases where the daemon
 *      itself crashed (or was SIGKILL'd) before the per-socket auto-end
 *      had a chance to fire.
 *   2. Sessions ended longer than `hardDeleteDays` are hard-deleted to keep
 *      `agent_sessions` from growing without bound.
 *
 * Idempotent — running twice in a row produces the same end state. Safe to
 * invoke on demand via the `harness.prune` RPC for ops use, in addition to
 * the periodic timer set up in `startDaemon`.
 */
async function runPrune(
  db: PGlite,
  staleDays: number,
  hardDeleteDays: number,
): Promise<{ aged: number; deleted: number }> {
  // Clamp non-negative + finite. Defends against bad caller input — a
  // negative or NaN threshold would otherwise widen the WHERE clause to
  // include all-or-no rows depending on Postgres semantics.
  const stale = Number.isFinite(staleDays) ? Math.max(0, staleDays) : 7;
  const hard = Number.isFinite(hardDeleteDays) ? Math.max(0, hardDeleteDays) : 30;

  // Parameterized interval avoids SQL injection on the days value.
  const aged = await db.query<{ id: string }>(
    `UPDATE agent_sessions
        SET ended_at = NOW(),
            exit_summary = COALESCE(exit_summary, 'pruned-stale')
      WHERE ended_at IS NULL
        AND started_at < NOW() - INTERVAL '1 day' * $1
      RETURNING id`,
    [stale],
  );
  const deleted = await db.query<{ id: string }>(
    `DELETE FROM agent_sessions
      WHERE ended_at IS NOT NULL
        AND ended_at < NOW() - INTERVAL '1 day' * $1
      RETURNING id`,
    [hard],
  );
  pruneState.lastRunAt = new Date();
  pruneState.lastAgedCount = aged.rows.length;
  pruneState.lastDeletedCount = deleted.rows.length;
  if (pruneState.lastAgedCount > 0 || pruneState.lastDeletedCount > 0) {
    log.info('prune complete', {
      aged: pruneState.lastAgedCount,
      deleted: pruneState.lastDeletedCount,
      staleDays: stale,
      hardDeleteDays: hard,
    });
  }
  return { aged: pruneState.lastAgedCount, deleted: pruneState.lastDeletedCount };
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

const handlers = new Map<string, RpcHandler>();

/** Register an RPC method handler. */
export function registerHandler(method: string, handler: RpcHandler): void {
  handlers.set(method, handler);
}

// ---------------------------------------------------------------------------
// Shutdown signal — module-level AbortController whose `.signal` aborts when
// the daemon is closing. Long-running helpers (e.g. git child-process spawn
// in vcs.ts) listen to this so they get SIGTERM'd before the daemon exits,
// rather than orphaning. Reset to a fresh controller on every startDaemon()
// so multiple sequential lifecycles in the same process (e.g. test setup +
// teardown loops) get independent shutdown windows.
// ---------------------------------------------------------------------------

let _shutdownController: AbortController | null = null;

/**
 * Returns the daemon's current shutdown AbortSignal, or `undefined` if the
 * daemon has not started (or has fully shut down). Helpers that spawn
 * child processes or hold long-running async work should pass this signal
 * to their abort-aware APIs.
 */
export function getShutdownSignal(): AbortSignal | undefined {
  return _shutdownController?.signal;
}

// ---------------------------------------------------------------------------
// In-flight handler counter + shutdown gate.
//
// `_activeHandlerCount` is incremented before each `await handler()` and
// decremented in finally; close() drains it before tearing down PGlite so
// a long-running handler (e.g. worktree.create shelling out to git) does
// not race with `db.close()`.
//
// `_closing` is set at the START of close() to gate any future dispatches
// on already-connected sockets — `server.close()` only stops new accepts,
// not new requests on existing sockets, so without this gate a persistent
// client could send a request that increments the counter AFTER the drain
// has observed zero and runs against a closing/closed PGlite. When set,
// dispatch responds with JSON-RPC -32099 ("Server is shutting down") and
// bails before the counter increment.
// ---------------------------------------------------------------------------

let _activeHandlerCount = 0;
let _closing = false;

/** Wait until `_activeHandlerCount === 0` or `deadlineMs` elapses. Polls
 *  every `tickMs` (default 10 ms). Returns `{drained, remaining}` so the
 *  caller can log a warning when the deadline passes with handlers still
 *  running. */
async function drainActiveHandlers(
  deadlineMs: number,
  tickMs = 10,
): Promise<{ drained: boolean; remaining: number }> {
  const start = Date.now();
  while (_activeHandlerCount > 0 && Date.now() - start < deadlineMs) {
    await new Promise((r) => setTimeout(r, tickMs));
  }
  return { drained: _activeHandlerCount === 0, remaining: _activeHandlerCount };
}

/** @internal — test-only seam. Lets the unit test set the counter directly
 *  to exercise the drain logic without spinning up a real daemon. */
export function _setActiveHandlerCountForTest(n: number): void {
  _activeHandlerCount = n;
}

/** @internal — test-only seam. Direct access to the drain helper so the
 *  unit test can verify deadline / immediate-resolve / progressive-drain
 *  behavior without going through close(). */
export function _drainActiveHandlersForTest(
  deadlineMs: number,
  tickMs?: number,
): Promise<{ drained: boolean; remaining: number }> {
  return drainActiveHandlers(deadlineMs, tickMs);
}

/** @internal — test-only seam. Set/clear the shutdown gate directly to
 *  verify dispatch rejection without spinning a full close() cycle. */
export function _setClosingForTest(closing: boolean): void {
  _closing = closing;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireAgent(ctx: SocketContext, params?: Record<string, unknown>): string {
  if (ctx.agentId) return ctx.agentId;
  // Fallback: accept `actorAgentId` in params for fresh-per-call clients
  // (e.g. Studio's Tauri bridge). The daemon does not authenticate — this
  // is local-trust; remote callers go through the HTTP gateway with auth.
  const actor = params ? strOrNull(params.actorAgentId) : null;
  if (actor) {
    ctx.agentId = actor;
    ctx.boundVia = 'param';
    return actor;
  }
  throw new Error('Not registered: call session.register or pass actorAgentId');
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

const SIG_TS_WINDOW_SECS = 60;
const NONCE_SWEEP_WINDOW_MINUTES = 10;

async function verifyOrWarn(req: RpcRequest, db: PGlite, ctx: SocketContext): Promise<void> {
  // Reset any prior signature binding on this socket before processing the
  // current request. Connection-level bindings (register/attach/param) are
  // restored from the pre-signature snapshot. Without this, a signed call
  // would leave ctx.agentId = SIGNED_ID forever on the socket, and any
  // later unsigned call would pass the identity gate as that agent.
  if (ctx.boundVia === 'signature') {
    ctx.agentId = ctx.preSignatureAgentId;
    ctx.agentName = ctx.preSignatureAgentName;
    ctx.boundVia = ctx.preSignatureBoundVia;
    ctx.verifiedSignature = null;
    ctx.preSignatureAgentId = null;
    ctx.preSignatureAgentName = null;
    ctx.preSignatureBoundVia = null;
  }

  const envelopeStr = req['x-revdev-signature'];
  if (!envelopeStr) {
    log.debug('no signature', { method: req.method });
    return;
  }

  const parsed = parseEnvelope(envelopeStr);
  if (!parsed) {
    log.warn('signature parse failed', { method: req.method });
    return;
  }

  const didParsed = parseDid(parsed.payload.did);
  if (!didParsed) {
    log.warn('signature did unparseable', { did: parsed.payload.did });
    return;
  }

  if (parsed.payload.kid !== didParsed.fingerprint) {
    log.warn('kid does not match did fingerprint', {
      kid: parsed.payload.kid,
      fingerprint: didParsed.fingerprint,
    });
    return;
  }

  const keyRow = await db.query<{ public_key_pem: string }>(
    `SELECT public_key_pem FROM agent_identity_keys
     WHERE fingerprint = $1 AND agent_id = $2 AND superseded_at IS NULL`,
    [parsed.payload.kid, didParsed.agentId],
  );
  if (keyRow.rows.length === 0) {
    log.warn('signature unknown key', { kid: parsed.payload.kid, agentId: didParsed.agentId });
    return;
  }

  const publicKeyPem = keyRow.rows[0]?.public_key_pem;
  if (!publicKeyPem || !verifyEnvelope(parsed, publicKeyPem)) {
    log.warn('signature invalid', { kid: parsed.payload.kid });
    return;
  }

  if (Math.abs(Date.now() / 1000 - parsed.payload.ts) > SIG_TS_WINDOW_SECS) {
    log.warn('signature ts outside window', { ts: parsed.payload.ts });
    return;
  }

  if (parsed.payload.method !== req.method) {
    log.warn('signature method mismatch', {
      payloadMethod: parsed.payload.method,
      reqMethod: req.method,
    });
    return;
  }

  if (hashParams(req.method, req.params) !== parsed.payload.paramsHash) {
    log.warn('signature paramsHash mismatch', { method: req.method });
    return;
  }

  try {
    await db.query(`INSERT INTO agent_identity_nonces (nonce, agent_id) VALUES ($1, $2)`, [
      parsed.payload.nonce,
      didParsed.agentId,
    ]);
  } catch {
    log.warn('signature nonce replay', { nonce: parsed.payload.nonce, agentId: didParsed.agentId });
    return;
  }

  // Snapshot the pre-signature connection identity so the NEXT request can
  // restore it if it arrives unsigned (or with an invalid signature). Only
  // register/attach/param survive across requests; the signature override is
  // ephemeral. (Any prior 'signature' binding was already cleared at the top
  // of this function, so boundVia here is one of register/attach/param/null.)
  ctx.preSignatureAgentId = ctx.agentId;
  ctx.preSignatureAgentName = ctx.agentName;
  ctx.preSignatureBoundVia = ctx.boundVia;
  ctx.agentId = didParsed.agentId;
  ctx.boundVia = 'signature';
  ctx.verifiedSignature = { kid: parsed.payload.kid, nonce: parsed.payload.nonce };
}

/** Accept either `paths: string[]` or `filePath: string` — normalize to array. */
function normalizePaths(params: Record<string, unknown>): string[] {
  const paths = asStringArray(params.paths);
  if (paths.length > 0) return paths;
  const single = strOrNull(params.filePath);
  return single ? [single] : [];
}

// ---------------------------------------------------------------------------
// Built-in handlers
// ---------------------------------------------------------------------------

registerHandler('ping', async () => ({ pong: true, ts: Date.now() }));

// -- Session ----------------------------------------------------------------

registerHandler('session.register', async (params, db, ctx) => {
  // Two registration modes:
  //   1. Ephemeral (no agentId): generate a UUID. Studio/Terminal flow.
  //   2. Stable (agentId supplied): UPSERT on that id. Used by Claude Code
  //      hooks which want long-lived role identities like "conductor" or
  //      "agent-system" that persist across reboots and can be targeted by
  //      name from other agents' mail/tasks calls. Idempotent — re-registering
  //      the same id re-opens an ended session.
  const supplied = strOrNull(params.agentId);
  const id = supplied ?? crypto.randomUUID();
  const agentName = str(params.agentName, supplied ?? 'anon');
  const workDir = str(params.workDir) || str(params.task);
  const backend = str(params.backend, str(params.env, 'unknown'));
  const env = `${backend}:${agentName}`;
  const pid = num(params.pid, 0) || null;
  const forceRotate = params.forceRotate === true;

  if (supplied) {
    // UPSERT: insert or re-open existing row.
    await db.query(
      `INSERT INTO agent_sessions (id, env, task, pid)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         env = EXCLUDED.env,
         task = EXCLUDED.task,
         pid = EXCLUDED.pid,
         updated_at = NOW(),
         ended_at = NULL,
         exit_summary = NULL`,
      [id, env, workDir, pid],
    );
  } else {
    await db.query(`INSERT INTO agent_sessions (id, env, task, pid) VALUES ($1, $2, $3, $4)`, [
      id,
      env,
      workDir,
      pid,
    ]);
  }

  // Bind this identity to the connection.
  ctx.agentId = id;
  ctx.agentName = agentName;
  ctx.boundVia = 'register';

  // Best-effort dual-write to Neon. Failures are logged inside the helper;
  // the RPC succeeds based on the PGlite write above. See GAP-154 §E /
  // Phase 1 decision #5 ("dual-write failure: best-effort, don't fail RPC").
  await syncSessionRegister({ agentId: id, agentName, env, task: workDir, pid });

  // Agent identity bootstrap: generate or reuse an Ed25519 keypair and
  // persist it to the agent_identity + agent_identity_keys tables.
  // Returns the DID and public key PEM to include in the response.
  const { did, publicKeyPem } = await bootstrapAgentIdentity(db, id, forceRotate);

  // Include `session: {id}` for back-compat with hook clients that read
  // `result.session.id`. New clients should use `sessionId`/`agentId`.
  return {
    sessionId: id,
    agentId: id,
    agentName,
    backend,
    did,
    publicKeyPem,
    session: { id, env, task: workDir },
  };
});

interface IdentityResult {
  did: string;
  publicKeyPem: string;
}

async function bootstrapAgentIdentity(
  db: PGlite,
  agentId: string,
  forceRotate: boolean,
): Promise<IdentityResult> {
  const existing = await db.query<{ did: string; fingerprint: string; public_key_pem: string }>(
    `SELECT did, fingerprint, public_key_pem FROM agent_identity WHERE agent_id = $1`,
    [agentId],
  );

  if (existing.rows.length > 0 && !forceRotate) {
    const row = existing.rows[0] as { did: string; fingerprint: string; public_key_pem: string };
    return { did: row.did, publicKeyPem: row.public_key_pem };
  }

  const kp = generateAgentKeypair();
  const fingerprint = computeFingerprint(kp.publicKeyRaw);
  const did = formatDid(agentId, fingerprint);

  if (existing.rows.length === 0) {
    await db.query(
      `INSERT INTO agent_identity (agent_id, did, fingerprint, public_key_pem)
       VALUES ($1, $2, $3, $4)`,
      [agentId, did, fingerprint, kp.publicKeyPem],
    );
    await db.query(
      `INSERT INTO agent_identity_keys (fingerprint, agent_id, public_key_pem)
       VALUES ($1, $2, $3)`,
      [fingerprint, agentId, kp.publicKeyPem],
    );
  } else {
    await db.query(
      `UPDATE agent_identity_keys
       SET superseded_at = NOW()
       WHERE agent_id = $1 AND superseded_at IS NULL`,
      [agentId],
    );
    await db.query(
      `INSERT INTO agent_identity_keys (fingerprint, agent_id, public_key_pem)
       VALUES ($1, $2, $3)`,
      [fingerprint, agentId, kp.publicKeyPem],
    );
    await db.query(
      `UPDATE agent_identity
       SET did = $1, fingerprint = $2, public_key_pem = $3, last_seen_at = NOW()
       WHERE agent_id = $4`,
      [did, fingerprint, kp.publicKeyPem, agentId],
    );
  }

  void persistIdentityToRevvault(agentId, kp.privateKeyPem, kp.publicKeyPem);

  return { did, publicKeyPem: kp.publicKeyPem };
}

function persistIdentityToRevvault(
  agentId: string,
  privateKeyPem: string,
  publicKeyPem: string,
): Promise<void> {
  return (async () => {
    const setPriv = await revvaultSet(
      `revdev/agents/${agentId}/identity/ed25519-private`,
      privateKeyPem,
    );
    if (!setPriv.ok) {
      log.warn('revvault private key write failed', { agentId, reason: setPriv.reason });
    }
    const setPub = await revvaultSet(
      `revdev/agents/${agentId}/identity/ed25519-public`,
      publicKeyPem,
    );
    if (!setPub.ok) {
      log.warn('revvault public key write failed', { agentId, reason: setPub.reason });
    }
  })();
}

registerHandler('session.attach', async (params, db, ctx) => {
  // Accept canonical sessionId, fall back to agentId alias (in this codebase
  // the session row's `id` column IS the agentId — they're the same value
  // bound at session.register time).
  const sessionId = strOrNull(params.sessionId) ?? strOrNull(params.agentId);
  if (!sessionId) throw new Error('session.attach: missing sessionId or agentId');
  const r = await db.query<{ id: string; env: string }>(
    `SELECT id, env FROM agent_sessions WHERE id = $1 AND ended_at IS NULL`,
    [sessionId],
  );
  if (r.rows.length === 0) {
    throw new Error(`session.attach: unknown or ended session ${sessionId}`);
  }
  ctx.agentId = sessionId;
  ctx.agentName = r.rows[0]?.env.split(':')[1] ?? null;
  ctx.boundVia = 'attach';
  return { attached: true, sessionId, agentId: sessionId };
});

registerHandler('session.list', async (params, db) => {
  // Default scope is 'local' — query the daemon's own PGlite, which is
  // fast (in-process) and authoritative for this machine.
  // scope='fleet' queries the Neon coordination_sessions table for active
  // sessions across ALL daemons writing to the same Neon db. This is the
  // signal callers want for cross-machine peer detection. Returns an
  // empty list (not an error) when Neon sync is disabled — callers can
  // distinguish via harness.health.neonSyncActive.
  const scope = strOrNull(params.scope);
  if (scope === 'fleet') {
    const fleet = await listFleetSessions();
    return { sessions: fleet, scope: 'fleet', neonSyncActive: isNeonSyncActive() };
  }
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM agent_sessions WHERE ended_at IS NULL ORDER BY started_at DESC`,
  );
  return { sessions: result.rows, scope: 'local' };
});

registerHandler('session.end', async (params, db, ctx) => {
  // Prefer caller's own session, but allow explicit override (e.g. admin cleanup).
  const target = strOrNull(params.sessionId) ?? strOrNull(params.agentId) ?? ctx.agentId;
  if (!target) throw new Error('No session to end');
  // Canonical: exitSummary (matches DB column `exit_summary`).
  // Compat alias: summary (for callers using shorter name).
  const exitSummary = strOrNull(params.exitSummary) ?? strOrNull(params.summary);
  await db.query(
    `UPDATE agent_sessions
        SET ended_at = NOW(),
            exit_summary = COALESCE($2, exit_summary)
      WHERE id = $1`,
    [target, exitSummary],
  );
  if (ctx.agentId === target) {
    ctx.agentId = null;
    ctx.agentName = null;
  }
  // Best-effort dual-write — see GAP-154 §E.
  await syncSessionEnd({ sessionId: target, summary: exitSummary });
  return { ended: target };
});

registerHandler('session.update', async (params, db, ctx) => {
  const target = strOrNull(params.sessionId) ?? strOrNull(params.agentId) ?? ctx.agentId;
  if (!target) throw new Error('No session to update');
  const task = strOrNull(params.task);
  const files = strOrNull(params.files);

  // Build the update dynamically but keep values parameterized.
  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];
  let i = 1;
  if (task !== null) {
    sets.push(`task = $${i++}`);
    vals.push(task);
  }
  if (files !== null) {
    sets.push(`files = $${i++}`);
    vals.push(files);
  }
  vals.push(target);
  await db.query(`UPDATE agent_sessions SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  // Best-effort dual-write — task is the only column the Neon-side
  // session row exposes from the daemon's update; files / updated_at
  // are daemon-only concerns. See GAP-154 §E.
  if (task !== null) {
    await syncSessionUpdate({ sessionId: target, task });
  }
  return { updated: target };
});

// -- Mail -------------------------------------------------------------------

registerHandler('mail.send', async (params, db, ctx) => {
  const from = requireAgent(ctx, params);
  const to = strOrNull(params.to) ?? strOrNull(params.toAgent);
  if (!to) throw new Error('mail.send: missing "to" (or "toAgent")');
  const subject = str(params.subject);
  const body = str(params.body);

  const result = await db.query<{ id: number }>(
    `INSERT INTO agent_messages (from_agent, to_agent, subject, body)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [from, to, subject, body],
  );
  // Best-effort dual-write to coordination_mail (GAP-154 Phase 3).
  await syncMailSend({ fromAgent: from, toAgent: to, subject, body });
  return { sent: true, id: result.rows[0]?.id ?? null };
});

registerHandler('mail.inbox', async (params, db, ctx) => {
  // Explicit agentId param wins (for debugging / admin). Otherwise use caller.
  const agentId = strOrNull(params.agentId) ?? requireAgent(ctx, params);
  const unreadOnly = params.unreadOnly !== false; // default true

  const sql = unreadOnly
    ? `SELECT * FROM agent_messages WHERE to_agent = $1 AND read = FALSE
       ORDER BY created_at DESC LIMIT 50`
    : `SELECT * FROM agent_messages WHERE to_agent = $1
       ORDER BY created_at DESC LIMIT 50`;
  const result = await db.query<Record<string, unknown>>(sql, [agentId]);
  return { messages: result.rows };
});

registerHandler('mail.broadcast', async (params, db, ctx) => {
  const from = requireAgent(ctx, params);
  const subject = str(params.subject);
  const body = str(params.body);

  const sessions = await db.query<{ id: string }>(
    `SELECT id FROM agent_sessions WHERE ended_at IS NULL AND id <> $1`,
    [from],
  );
  for (const target of sessions.rows) {
    await db.query(
      `INSERT INTO agent_messages (from_agent, to_agent, subject, body)
       VALUES ($1, $2, $3, $4)`,
      [from, target.id, subject, body],
    );
  }
  // Best-effort dual-write to coordination_mail (GAP-154 Phase 3).
  await syncMailBroadcast({
    fromAgent: from,
    toAgents: sessions.rows.map((r) => r.id),
    subject,
    body,
  });
  return { broadcast: true, sent: sessions.rows.length, recipients: sessions.rows.length };
});

registerHandler('mail.markRead', async (params, db, ctx) => {
  const agentId = requireAgent(ctx, params);
  // Accept number[] or string[] (JSON numbers or numeric strings).
  const raw = Array.isArray(params.messageIds) ? params.messageIds : [];
  const ids = raw
    .map((v) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN))
    .filter((n) => Number.isFinite(n));
  if (ids.length === 0) return { marked: 0 };

  // Fetch (subject, body) hints BEFORE the update so we can scope the
  // Neon sync. Without these the sync falls back to "mark N oldest unread"
  // which is over-broad. See syncMailMarkRead notes.
  const hintRows = await db.query<{ subject: string; body: string }>(
    `SELECT subject, body FROM agent_messages
     WHERE to_agent = $1 AND id = ANY($2::int[]) AND read = FALSE`,
    [agentId, ids],
  );

  const result = await db.query(
    `UPDATE agent_messages SET read = TRUE
     WHERE to_agent = $1 AND id = ANY($2::int[])`,
    [agentId, ids],
  );
  // Best-effort dual-write to coordination_mail (GAP-154 Phase 3).
  await syncMailMarkRead({ reader: agentId, ids, hints: hintRows.rows });
  return { marked: result.affectedRows ?? ids.length };
});

// -- File reservations ------------------------------------------------------

registerHandler('files.reserve', async (params, db, ctx) => {
  const agentId = requireAgent(ctx, params);
  const paths = normalizePaths(params);
  if (paths.length === 0) throw new Error('files.reserve: missing paths');
  const reason = str(params.reason);
  const ttlSeconds = num(params.ttlSeconds, 30 * 60);

  const reserved: string[] = [];
  const conflicts: Array<{ path: string; holder: string }> = [];

  for (const p of paths) {
    // Check if another active agent holds it.
    const existing = await db.query<{ agent_id: string; expires_at: string }>(
      `SELECT agent_id, expires_at FROM file_reservations
       WHERE file_path = $1 AND expires_at > NOW()`,
      [p],
    );
    const holder = existing.rows[0];
    if (holder && holder.agent_id !== agentId) {
      conflicts.push({ path: p, holder: holder.agent_id });
      continue;
    }

    await db.query(
      `INSERT INTO file_reservations (file_path, agent_id, expires_at, reason)
       VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval, $4)
       ON CONFLICT (file_path) DO UPDATE
         SET agent_id = EXCLUDED.agent_id,
             reserved_at = NOW(),
             expires_at = EXCLUDED.expires_at,
             reason = EXCLUDED.reason`,
      [p, agentId, String(ttlSeconds), reason],
    );
    reserved.push(p);
  }

  // Best-effort dual-write to coordination_file_claims (GAP-154 Phase 3).
  // Only sync the paths we actually reserved (not conflicts). The TTL +
  // reason fields don't exist on the Neon side; PGlite remains the source
  // of truth for expiry. See syncFilesReserve notes.
  if (reserved.length > 0) {
    await syncFilesReserve({ sessionId: agentId, paths: reserved });
  }
  return {
    success: conflicts.length === 0,
    reserved,
    conflicts,
  };
});

registerHandler('files.check', async (params, db) => {
  const paths = normalizePaths(params);
  if (paths.length === 0) return { reservations: [] };
  const result = await db.query<Record<string, unknown>>(
    `SELECT file_path, agent_id, reserved_at, expires_at, reason
     FROM file_reservations
     WHERE file_path = ANY($1::text[]) AND expires_at > NOW()`,
    [paths],
  );
  return { reservations: result.rows };
});

registerHandler('files.release', async (params, db, ctx) => {
  const agentId = requireAgent(ctx, params);
  const paths = normalizePaths(params);

  // If no paths given, release all of this agent's reservations.
  if (paths.length === 0) {
    const r = await db.query(`DELETE FROM file_reservations WHERE agent_id = $1`, [agentId]);
    // Best-effort dual-write to coordination_file_claims (GAP-154 Phase 3).
    await syncFilesRelease({ sessionId: agentId, paths: [] });
    return { released: r.affectedRows ?? 0 };
  }

  const r = await db.query(
    `DELETE FROM file_reservations
     WHERE agent_id = $1 AND file_path = ANY($2::text[])`,
    [agentId, paths],
  );
  // Best-effort dual-write (GAP-154 Phase 3).
  await syncFilesRelease({ sessionId: agentId, paths });
  return { released: r.affectedRows ?? 0 };
});

registerHandler('files.list', async (params, db) => {
  const agentId = strOrNull(params.agentId);
  const sql = agentId
    ? `SELECT * FROM file_reservations WHERE expires_at > NOW() AND agent_id = $1
       ORDER BY reserved_at DESC`
    : `SELECT * FROM file_reservations WHERE expires_at > NOW()
       ORDER BY reserved_at DESC`;
  const result = await db.query<Record<string, unknown>>(sql, agentId ? [agentId] : []);
  return { reservations: result.rows };
});

// -- Tasks ------------------------------------------------------------------

registerHandler('tasks.create', async (params, db) => {
  // Allow caller-supplied taskId (useful for stable external IDs) or generate one.
  const id = strOrNull(params.taskId) ?? crypto.randomUUID();
  const title = str(params.title);
  const description = str(params.description);
  const priority = strOrNull(params.priority);
  const full = [priority ? `[${priority}]` : '', title, description ? `— ${description}` : '']
    .filter(Boolean)
    .join(' ')
    .trim();

  await db.query(`INSERT INTO tasks (id, description, status) VALUES ($1, $2, 'open')`, [
    id,
    full || description || title || '(untitled)',
  ]);
  // Best-effort dual-write to coordination_work_items (GAP-154 Phase 3).
  // Map daemon's flat description into Neon's title + description split.
  // Numeric priority on the Neon side: 'low'→0 'normal'→0 'high'→1 'urgent'→2.
  const priorityNum = priority === 'urgent' ? 2 : priority === 'high' ? 1 : 0;
  await syncTaskCreate({
    id,
    title: title || description || id,
    description: title && description ? description : '',
    priority: priorityNum,
  });
  return { taskId: id, id };
});

registerHandler('tasks.list', async (params, db) => {
  const status = strOrNull(params.status);
  const owner = strOrNull(params.owner);

  const where: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (status && status !== 'all') {
    where.push(`status = $${i++}`);
    vals.push(status);
  }
  if (owner) {
    where.push(`owner = $${i++}`);
    vals.push(owner);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM tasks ${whereClause} ORDER BY created_at DESC`,
    vals,
  );
  return { tasks: result.rows };
});

registerHandler('tasks.claim', async (params, db, ctx) => {
  const agentId = requireAgent(ctx, params);
  const taskId = strOrNull(params.taskId);
  if (!taskId) throw new Error('tasks.claim: missing taskId');

  // Atomic CAS: only claim if open or already held by us.
  const r = await db.query<{ owner: string | null }>(
    `UPDATE tasks SET status = 'claimed', owner = $1, claimed_at = NOW()
     WHERE id = $2 AND (status = 'open' OR owner = $1)
     RETURNING owner`,
    [agentId, taskId],
  );
  if (r.rows.length === 0) {
    const current = await db.query<{ owner: string | null; status: string }>(
      `SELECT owner, status FROM tasks WHERE id = $1`,
      [taskId],
    );
    return {
      success: false,
      claimed: false,
      owner: current.rows[0]?.owner ?? null,
      status: current.rows[0]?.status ?? 'unknown',
    };
  }
  // Best-effort dual-write (GAP-154 Phase 3).
  await syncTaskClaim({ taskId, ownerAgent: agentId });
  return { success: true, claimed: taskId, owner: agentId };
});

registerHandler('tasks.complete', async (params, db, ctx) => {
  const agentId = requireAgent(ctx, params);
  const taskId = strOrNull(params.taskId);
  if (!taskId) throw new Error('tasks.complete: missing taskId');
  const summary = strOrNull(params.summary);

  // Only the claiming agent may complete.
  const r = summary
    ? await db.query(
        `UPDATE tasks SET status = 'completed', completed_at = NOW(),
           description = description || ' — ' || $3
         WHERE id = $1 AND owner = $2`,
        [taskId, agentId, summary],
      )
    : await db.query(
        `UPDATE tasks SET status = 'completed', completed_at = NOW()
         WHERE id = $1 AND owner = $2`,
        [taskId, agentId],
      );
  const ok = (r.affectedRows ?? 0) > 0;
  // Best-effort dual-write (GAP-154 Phase 3).
  // Translates daemon 'completed' → Neon 'done' inside the helper.
  if (ok) {
    await syncTaskComplete({ taskId, ownerAgent: agentId, summary });
  }
  return { ok, completed: ok ? taskId : null };
});

registerHandler('tasks.release', async (params, db, ctx) => {
  const agentId = requireAgent(ctx, params);
  const taskId = strOrNull(params.taskId);
  if (!taskId) throw new Error('tasks.release: missing taskId');

  const r = await db.query(
    `UPDATE tasks SET status = 'open', owner = NULL, claimed_at = NULL
     WHERE id = $1 AND owner = $2`,
    [taskId, agentId],
  );
  const ok = (r.affectedRows ?? 0) > 0;
  // Best-effort dual-write (GAP-154 Phase 3).
  if (ok) {
    await syncTaskRelease({ taskId, ownerAgent: agentId });
  }
  return { ok, released: ok ? taskId : null };
});

// -- Events -----------------------------------------------------------------

registerHandler('events.log', async (params, db, ctx) => {
  const agentId = strOrNull(params.agentId) ?? ctx.agentId ?? 'anonymous';
  const eventType = str(params.eventType, 'event');
  const payload = params.payload ?? {};
  await db.query(`INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
    agentId,
    eventType,
    JSON.stringify(payload),
  ]);
  // Best-effort dual-write to coordination_events (GAP-154 Phase 3).
  await syncEventLog({ agentId, type: eventType, payload });
  return { logged: true };
});

registerHandler('events.query', async (params, db) => {
  const limit = Math.min(num(params.limit, 20), 500);
  const since = strOrNull(params.since);
  const sql = since
    ? `SELECT * FROM events WHERE created_at > $1::timestamp ORDER BY created_at DESC LIMIT $2`
    : `SELECT * FROM events ORDER BY created_at DESC LIMIT $1`;
  const result = await db.query<Record<string, unknown>>(sql, since ? [since, limit] : [limit]);
  return { events: result.rows };
});

// -- Health -----------------------------------------------------------------

registerHandler('harness.health', async (_params, db) => {
  const sessions = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM agent_sessions WHERE ended_at IS NULL`,
  );
  const tasks = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM tasks WHERE status = 'open'`,
  );
  return {
    status: 'healthy',
    activeSessions: Number(sessions.rows[0]?.count ?? 0),
    openTasks: Number(tasks.rows[0]?.count ?? 0),
    uptime: process.uptime(),
    prune: {
      lastRunAt: pruneState.lastRunAt?.toISOString() ?? null,
      lastAgedCount: pruneState.lastAgedCount,
      lastDeletedCount: pruneState.lastDeletedCount,
    },
    // GAP-154: signal whether daemon→Neon sync is wired this run. Callers
    // can use this to decide whether `session.list({scope:'fleet'})`
    // returning empty means "no peers" or "no fleet visibility".
    neonSyncActive: isNeonSyncActive(),
    identitySignatureMode: 'accept-if-present' as const,
  };
});

registerHandler('harness.prune', async (params, db) => {
  // Allow ops / tests to run a prune pass on demand. Defaults match
  // DAEMON_DEFAULTS so callers can invoke with no params.
  const staleDays = num(params.staleDays, DAEMON_DEFAULTS.staleSessionDays);
  const hardDeleteDays = num(params.hardDeleteDays, DAEMON_DEFAULTS.hardDeleteDays);
  const result = await runPrune(db, staleDays, hardDeleteDays);
  return {
    aged: result.aged,
    deleted: result.deleted,
    runAt: pruneState.lastRunAt?.toISOString() ?? null,
    staleDays,
    hardDeleteDays,
  };
});

// -- Memory -----------------------------------------------------------------

registerHandler('memory.store', async (params, db, ctx) => {
  const agentId = requireAgent(ctx, params);
  const memoryType = str(params.memoryType);
  const content = str(params.content);
  const metadataInput =
    params.metadata && typeof params.metadata === 'object' && !Array.isArray(params.metadata)
      ? (params.metadata as Record<string, unknown>)
      : {};
  await db.query(
    `INSERT INTO agent_memory (agent_id, memory_type, content, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [agentId, memoryType, content, JSON.stringify(metadataInput)],
  );
  return { stored: memoryType };
});

registerHandler('memory.query', async (params, db, ctx) => {
  const agentId = requireAgent(ctx, params);
  const memoryType = strOrNull(params.memoryType);
  const query = strOrNull(params.query);
  const tags = asStringArray(params.tags);
  const limit = Math.min(num(params.limit, 10), 200);

  // Build WHERE clause dynamically based on which filters are present.
  const where: string[] = ['agent_id = $1'];
  const args: unknown[] = [agentId];
  let p = 2;
  if (memoryType) {
    where.push(`memory_type = $${p++}`);
    args.push(memoryType);
  }
  if (query) {
    where.push(`content ILIKE $${p++}`);
    args.push(`%${query}%`);
  }
  if (tags && tags.length > 0) {
    // PG ?| operator: any tag in the array matches a tag in metadata->'tags'.
    where.push(`metadata->'tags' ?| $${p++}::text[]`);
    args.push(tags);
  }
  args.push(limit);
  const sql = `SELECT * FROM agent_memory
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${p}`;

  const result = await db.query<Record<string, unknown>>(sql, args);
  return { memories: result.rows };
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startDaemon(
  config: Partial<DaemonConfig> = {},
): Promise<{ close: () => Promise<void>; _db: PGlite }> {
  const cfg = { ...DAEMON_DEFAULTS, ...config };

  // Reset shutdown signal + closing gate for this daemon lifecycle.
  // _shutdownController is aborted in close(); _closing is set to true
  // at the start of close() and reset to false at the end.
  _shutdownController = new AbortController();
  _closing = false;

  // Initialize license guard (logs banner)
  initLicenseGuard();

  // Initialize Neon sync (GAP-154 Phase 2). No-op when POSTGRES_URL is
  // unset — daemon runs single-machine fine; sync is purely additive.
  initNeonSync();

  // Ensure data directory exists
  await mkdir(cfg.dataDir, { recursive: true });
  await mkdir(dirname(cfg.socketPath), { recursive: true });

  // Initialize PGlite and bring the schema to the latest version. A failed
  // or future-version migration throws MigrationError — the daemon refuses
  // to start rather than run on a half-migrated schema (fail-fast).
  log.info('initializing database', { dataDir: cfg.dataDir });
  const db = new PGlite(cfg.dataDir);
  const migration = await migrate(db);
  log.info('schema migrated', {
    version: migration.current,
    applied: migration.applied.length > 0 ? migration.applied : 'none',
  });

  // Initialize observability (metrics + health checks)
  initObservability(db);

  // Periodic prune of stale + old-completed sessions (GAP-153). Disabled
  // when pruneIntervalMs is 0. unref() so the timer doesn't keep the
  // process alive on its own. The startup prune runs after a short delay
  // so it doesn't block the listen call.
  let pruneTimer: NodeJS.Timeout | null = null;
  if (cfg.pruneIntervalMs > 0) {
    pruneTimer = setInterval(() => {
      runPrune(db, cfg.staleSessionDays, cfg.hardDeleteDays).catch((err) =>
        log.warn('periodic prune failed', { error: String(err) }),
      );
    }, cfg.pruneIntervalMs);
    pruneTimer.unref();
    setTimeout(() => {
      runPrune(db, cfg.staleSessionDays, cfg.hardDeleteDays).catch((err) =>
        log.warn('startup prune failed', { error: String(err) }),
      );
    }, 5000).unref();
  }

  // Nonce sweep: remove nonces older than NONCE_SWEEP_WINDOW_MINUTES (2x the
  // SIG_TS_WINDOW_SECS validity window) so replay protection does not
  // accumulate nonces forever. Runs every 5 minutes, independent of the
  // session prune interval.
  const nonceSweepTimer = setInterval(
    () => {
      db.query(
        `DELETE FROM agent_identity_nonces
       WHERE seen_at < NOW() - INTERVAL '1 minute' * $1`,
        [NONCE_SWEEP_WINDOW_MINUTES],
      ).catch((err) => log.warn('nonce sweep failed', { error: String(err) }));
    },
    5 * 60 * 1000,
  );
  nonceSweepTimer.unref();

  // License expiry re-check (GAP-184). Daily while running: refresh metrics,
  // log expiry warnings, and record a license.* event so Studio can surface
  // expiry status in its dashboard. Startup is the fail-closed gate
  // (initLicenseGuard above); this timer never tears the daemon down — it
  // reports loudly and lets the next restart fail closed.
  const licenseRecheckTimer = setInterval(
    () => {
      let ev: ReturnType<typeof runtimeLicenseRecheck>;
      try {
        ev = runtimeLicenseRecheck();
      } catch (err) {
        log.warn('license recheck failed', { error: String(err) });
        return;
      }
      if (ev.status === 'expired' || ev.status.startsWith('expiring-')) {
        const eventType =
          ev.status === 'expired' ? 'license.expired' : 'license.expiry-approaching';
        const payload = {
          status: ev.status,
          tier: ev.tier,
          expiresAt: ev.expiresAt,
          secondsRemaining: ev.secondsRemaining,
        };
        // Local insert + best-effort Neon mirror (coordination_events), matching
        // the events.log handler's dual-write, so fleet/admin dashboards see
        // license telemetry when POSTGRES_URL is configured.
        db.query(`INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
          'revdev-daemon',
          eventType,
          JSON.stringify(payload),
        ])
          .then(() => syncEventLog({ agentId: 'revdev-daemon', type: eventType, payload }))
          .catch((err) => log.warn('license event log failed', { error: String(err) }));
      }
    },
    24 * 60 * 60 * 1000,
  );
  licenseRecheckTimer.unref();

  // Remove stale socket
  const { unlink, chmod } = await import('node:fs/promises');
  await unlink(cfg.socketPath).catch(() => {});

  // Track open sockets so close() can force-destroy them before
  // resetting state. server.close() only stops new accepts; existing
  // sockets stay alive until the client disconnects, which means their
  // `data` handlers can fire AFTER close() returns and dispatch against
  // a closed PGlite or against a fresh startDaemon()'s state in the
  // same process. Destroying sockets in close() prevents that.
  const openSockets = new Set<Socket>();

  // Start Unix socket server
  const server = createServer((socket: Socket) => {
    openSockets.add(socket);
    onConnect();
    const ctx: SocketContext = {
      agentId: null,
      agentName: null,
      boundVia: null,
      verifiedSignature: null,
      preSignatureAgentId: null,
      preSignatureAgentName: null,
      preSignatureBoundVia: null,
    };
    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      // Bound the per-socket reassembly buffer's _partial_ remainder. A
      // client that streams bytes without a newline grows `buffer`
      // linearly; without this check, a malicious or stuck client could
      // exhaust daemon memory via a single open socket. On overflow,
      // emit a JSON-RPC -32700 parse-error (id null — we never reached
      // a JSON boundary) and destroy the socket. The client must
      // reconnect. Use Buffer.byteLength so the cap is enforced in
      // UTF-8 bytes (matching the documented "bytes" semantics) rather
      // than UTF-16 code units, otherwise multibyte payloads bypass the
      // intended protection.
      if (Buffer.byteLength(buffer, 'utf8') > cfg.maxLineBytes) {
        log.warn('socket partial frame exceeded max line bytes; dropping connection', {
          bytes: Buffer.byteLength(buffer, 'utf8'),
          max: cfg.maxLineBytes,
        });
        socket.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: `Parse error: frame exceeded ${cfg.maxLineBytes} bytes without a newline`,
            },
          })}\n`,
        );
        buffer = '';
        socket.destroy();
        return;
      }

      for (const line of lines) {
        // The empty-line skip is a parsing aid (TCP can deliver partial
        // frames; an empty token between two newlines is not a request).
        // It is not a security check: an attacker sending an empty frame
        // gets nothing dispatched, which is the same protection an empty
        // frame produces in any other JSON-RPC line-delimited server.
        // The real authorization gates run downstream (license, validation,
        // signature, identity) and are tested in
        // packages/daemon/src/__tests__/coordination.test.ts.
        // codeql[js/user-controlled-bypass]
        if (!line.trim()) continue;

        // A complete (newline-terminated) frame can still exceed the cap
        // when an oversize chunk lands all in one event. Reject such a
        // frame with -32700 but keep the socket open — the client framed
        // the boundary correctly, they just sent too much data.
        if (Buffer.byteLength(line, 'utf8') > cfg.maxLineBytes) {
          log.warn('socket received oversized frame; rejecting', {
            bytes: Buffer.byteLength(line, 'utf8'),
            max: cfg.maxLineBytes,
          });
          socket.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32700,
                message: `Parse error: frame exceeded ${cfg.maxLineBytes} bytes`,
              },
            })}\n`,
          );
          continue;
        }

        let req: RpcRequest;
        try {
          req = JSON.parse(line);
        } catch {
          socket.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error' },
            })}\n`,
          );
          continue;
        }

        // License guard
        const guard = guardRpcMethod(req.method);
        if (!guard.allowed) {
          socket.write(`${licenseErrorResponse(req.id, guard)}\n`);
          continue;
        }

        // Validate params
        const validation = validateParams(req.method, req.params);
        if (!validation.valid) {
          socket.write(`${invalidParamsResponse(req.id, validation.error!)}\n`);
          continue;
        }

        // Dispatch
        const handler = handlers.get(req.method);
        if (!handler) {
          socket.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32601, message: `Method not found: ${req.method}` },
            })}\n`,
          );
          continue;
        }

        // Signature gate (accept-if-present, P1). Attempts to bind ctx.agentId
        // from a verified Ed25519 envelope. Never rejects the request — invalid
        // or missing signatures fall through to the identity gate below.
        await verifyOrWarn(req, db, ctx);

        // Identity gate: most coordination calls need a registered agent.
        // Fallback: accept `actorAgentId` in params (requireAgent will validate).
        if (
          !IDENTITY_EXEMPT.has(req.method) &&
          !ctx.agentId &&
          !(req.params && typeof req.params.actorAgentId === 'string')
        ) {
          socket.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              error: {
                code: -32002,
                message: `Not registered: call session.register or session.attach before ${req.method}`,
              },
            })}\n`,
          );
          continue;
        }

        // Shutdown gate. close() sets _closing BEFORE the drain so a
        // request arriving on an already-connected socket after shutdown
        // started cannot increment the counter past the drain observation
        // window and run against a closing/closed PGlite. We respond with
        // JSON-RPC -32099 ("Server is shutting down") and bail before the
        // counter increment.
        if (_closing) {
          socket.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32099, message: 'Server is shutting down' },
            })}\n`,
          );
          continue;
        }

        const startMs = Date.now();
        _activeHandlerCount++;
        try {
          const result = await handler(req.params ?? {}, db, ctx);
          trackRpcCall(req.method, 'ok', Date.now() - startMs);
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n`);
        } catch (err) {
          trackRpcCall(req.method, 'error', Date.now() - startMs);
          socket.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              error: {
                code: -32000,
                message: err instanceof Error ? err.message : 'Internal error',
              },
            })}\n`,
          );
        } finally {
          _activeHandlerCount--;
        }
      }
    });

    socket.on('close', async () => {
      openSockets.delete(socket);
      onDisconnect();
      // Auto-release transient reservations when a long-lived agent
      // disconnects. Fresh-per-call clients (boundVia = 'param') don't
      // trigger cleanup — their identity outlives this socket.
      //
      // Note: we do NOT auto-end the session row on socket close. The
      // daemon's session model is LOGICAL agent identity (not socket
      // lifetime): hooks open-call-close in <100ms per RPC and bind to
      // existing sessions via `actorAgentId` params; Studio etc. may
      // disconnect and reattach. The only end triggers are explicit
      // session.end and the periodic prune (GAP-153). A future
      // refinement (keepalive flag in session.register, or socket-
      // lifetime threshold) could re-introduce socket-close auto-end
      // for genuinely-long-lived agents — see GAP-153 notes.
      // Skip cleanup when shutdown has begun — db may already be closed.
      // close() destroys all sockets, which fires this handler; we don't
      // want it to race with db.close(). The .catch(() => {}) below
      // would swallow the resulting error anyway, but bailing here is
      // explicit + avoids the dangling Promise.
      if (!_closing && ctx.agentId && (ctx.boundVia === 'register' || ctx.boundVia === 'attach')) {
        await db
          .query(`DELETE FROM file_reservations WHERE agent_id = $1`, [ctx.agentId])
          .catch(() => {});
      }
    });

    socket.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    // Restrict the socket to the owning UID. umask 0o077 causes bind(2) to
    // create the socket file with mode 0600 from the moment it exists — no
    // race window where another local user could open it. The follow-up
    // chmod is belt-and-suspenders if something mutated umask concurrently.
    const prevUmask = process.umask(0o077);
    let umaskRestored = false;
    const restoreUmask = () => {
      if (!umaskRestored) {
        process.umask(prevUmask);
        umaskRestored = true;
      }
    };

    server.once('error', (err) => {
      restoreUmask();
      reject(err);
    });

    server.listen(cfg.socketPath, async () => {
      restoreUmask();
      try {
        await chmod(cfg.socketPath, 0o600);
      } catch (err) {
        reject(err);
        return;
      }
      log.info('listening', { socketPath: cfg.socketPath, mode: '0600' });
      log.info('ready for connections');

      resolve({
        _db: db,
        close: async () => {
          // Sequence:
          //   1. Set _closing FIRST so any RPC arriving on an existing
          //      socket from this point onward bails out with -32099
          //      before the counter increment.
          //   2. Abort the shutdown signal — SIGTERMs git children
          //      (vcs.ts) and aborts inference.* fetches; honoring
          //      handlers complete fast.
          //   3. server.close() — stop accepting NEW connections.
          //   4. Force-destroy ALL existing sockets — server.close()
          //      doesn't close them; without this, a persistent client
          //      could fire another `data` event with an old socket
          //      after close() returns and dispatch against a closed
          //      PGlite (Codex P2 catch on revdev#47 round 2).
          //   5. Drain still-running handlers (started BEFORE step 1)
          //      within the grace period.
          //   6. db.close() + unlink Unix socket.
          //   7. Reset _closing — safe now because no live socket
          //      references this state.
          _closing = true;
          _shutdownController?.abort();
          _shutdownController = null;
          if (pruneTimer) clearInterval(pruneTimer);
          clearInterval(nonceSweepTimer);
          clearInterval(licenseRecheckTimer);
          server.close();
          for (const s of openSockets) {
            s.destroy();
          }
          openSockets.clear();
          const drainResult = await drainActiveHandlers(cfg.shutdownGracePeriodMs);
          if (!drainResult.drained) {
            log.warn('shutdown grace period exceeded with handlers still running', {
              remaining: drainResult.remaining,
              gracePeriodMs: cfg.shutdownGracePeriodMs,
            });
          }
          await db.close();
          await unlink(cfg.socketPath).catch(() => {});
          // Now safe to reset — no live socket has a reference to module
          // state, and a fresh startDaemon() in the same process (test
          // setup/teardown loops) starts with a clean gate.
          _closing = false;
          log.info('shut down');
        },
      });
    });
  });
}
