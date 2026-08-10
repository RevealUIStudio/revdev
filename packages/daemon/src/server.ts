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

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { hostname as osHostname } from 'node:os';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { formatDid, parseDid } from '@revdev/protocol/did';
import { createLogger } from '@revealui/utils/logger';
import {
  computeFingerprint,
  generateAgentKeypair,
  hashParams,
  parseEnvelope,
  spkiPemToRaw,
  verifyEnvelope,
} from './agent-identity-crypto.js';
import { DAEMON_DEFAULTS, type DaemonConfig } from './config.js';
import { readRootOwnedFile } from './confinement.js';
import { GoalHarness, GoalStore } from './goals/index.js';
import {
  guardRpcMethod,
  initLicenseGuard,
  licenseErrorResponse,
  runtimeLicenseRecheck,
} from './guard.js';
import { HttpGateway } from './http-gateway.js';
import { evaluateLicense, LicenseConfigError, type LicenseTier, tierRank } from './license.js';
import { loopGuards } from './loop-guard.js';
import {
  getSelfDaemonId,
  heartbeatDaemonPeer,
  initNeonSync,
  isNeonSyncActive,
  listDaemonPeers,
  listFleetSessions,
  registerDaemonPeer,
  sweepExpiredFileClaims,
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
import {
  ApprovalRequiredError,
  decideApproval,
  decideEnforcement,
  emitPermissionShadowEvent,
  evaluateShadow,
  issueGrant,
  listGrants,
  listPendingApprovals,
  parseSessionPermissionMode,
  queueApprovalRequired,
  resolveEffectiveMode,
  resolvePermissionMode,
  revokeGrant,
  setSessionPermissionMode,
  tryConsumeApproval,
  tryConsumeGrant,
} from './permission.js';
import { initSessionChecks, runSessionChecks } from './session-checks/index.js';
import {
  normalizeFidelitySections,
  retentionCutoffIso,
  SNAPSHOT_RETENTION_DAYS,
} from './session-fidelity-snapshot.js';
import { migrate } from './storage/migrate.js';
import { initToolGuard } from './tool-guard/index.js';
import { invalidParamsResponse, validateParams } from './validation/index.js';
import { DESIGN_PACK_MOVED_EVENT, designPackEvents } from './design-pack-events.js';
import { notifyAgentEnded, notifyDaemonStarted, notifyDaemonStopping } from './eviction.js';
import { WORK_COMPLETED_EVENT, workEvents } from './work-events.js';

const log = createLogger({ service: 'revdev-daemon' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
  'x-revdev-signature'?: string;
}

/** A fully-formed JSON-RPC 2.0 response, as returned by {@link dispatchRpc}. */
export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Per-connection state. Populated on session.register or session.attach. */
export interface SocketContext {
  /** Agent identity for this socket. Null until session.register/attach succeeds. */
  agentId: string | null;
  /** Human-readable agent name (e.g. "agent-main"). */
  agentName: string | null;
  /**
   * How `agentId` was bound to this socket:
   *   - 'register'/'attach': long-lived identity (trigger cleanup on disconnect)
   *   - 'param': transient actorAgentId from a fresh-per-call client (never cleanup)
   *   - 'signature': bound via a verified Ed25519 envelope (never cleanup)
   *   - null: unbound
   */
  boundVia: 'register' | 'attach' | 'param' | 'signature' | null;
  keyOrigin: 'client' | 'daemon' | null;
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
  // GAP-459: peer metadata composite (same class as session.list — no file
  // content). Optional actorAgentId still labels isSelf when provided.
  'context.snapshot',
  'harness.health',
  // GAP-154 Phase 5: peer discovery is read-only fleet metadata (no content).
  'daemon.peers',
  // `harness.prune` was here. It reaches notifyAgentEnded for EVERY matched
  // session, so an identity-exempt, unsigned caller could evict every agent's
  // roots and kill every agent's PTY with one frame. See GAP-312 and the
  // MUTATING_OR_CONTENT_METHODS entry below.
  'inference.status',
  'inference.pull',
  'inference.delete',
  'inference.start',
  'inference.stop',
  'inference.chat',
  'inference.generate',
]);

/**
 * Result of the per-request signature check (`verifyOrWarn`).
 *   - 'verified': a well-formed Ed25519 envelope passed every check and
 *     `ctx.agentId` is now bound to the signer.
 *   - 'none': no `x-revdev-signature` was present.
 *   - 'invalid': a signature was present but failed a check (parse, unknown
 *     key, bad signature, stale ts, method/params mismatch, nonce replay).
 */
type VerificationResult = 'verified' | 'none' | 'invalid';

/**
 * Methods that MUST carry a verified Ed25519 signature — every mutation and
 * every content-returning read. The `0600` socket alone stops a hostile
 * non-owner WSL process, but ANY host process can `wsl.exe` in as the WSL
 * user and reach the socket; the signature is the real barrier that keeps
 * such a process from reading project files (or `~/.ssh`, `~/.age-identity`
 * via a traversal) or mutating the repo without Studio's per-install key.
 *
 * Only payload-free, repo-agnostic coordination methods (`ping`, `session.*`)
 * stay signature-OPTIONAL behind the `0600` boundary. The git metadata reads
 * (`git.status` / `git.listBranches` / `git.log`) are signature-REQUIRED too:
 * without it an unsigned caller reads another agent's branches / history /
 * dirty paths cross-agent (review B-1).
 */
export const MUTATING_OR_CONTENT_METHODS = new Set([
  // file surface — writes + content/metadata reads
  'file.read',
  'file.write',
  'file.delete',
  'file.stat',
  // git mutations
  'git.stageFile',
  'git.unstageFile',
  'git.discardFile',
  'git.createBranch',
  'git.switchBranch',
  'git.deleteBranch',
  'git.commit',
  'git.push',
  'git.pull',
  // worktree mutations — `git worktree add/remove` shells out as the daemon UID,
  // so they MUST be signed (binds ctx.agentId to the verified signer) and gated
  // by requireRoot in filegit.ts. Their absence from this set was the B-WT
  // blocker: an unsigned host process could session.register a bare identity and
  // drive `git worktree add` as the daemon UID (filter.* base → RCE on checkout).
  // Cross-language contract: signing.rs requires_signature() must mark these too.
  'worktree.create',
  'worktree.remove',
  // git content-returning reads (diffFile/diffContent embed source lines)
  'git.diffFile',
  'git.diffContent',
  'git.readBlobAtHead',
  'git.readBlobAtIndex',
  // Root registration. Signature-REQUIRED so the root is recorded under the
  // VERIFIED signer's agentId (filegit per-agent root scoping) rather than a
  // spoofable param — otherwise any unsigned caller could register a root that
  // a later signed mutation would be authorized against. (Cross-language
  // contract: signing.rs requires_signature() must mark project.open too.)
  'project.open',
  // git metadata reads — signature-REQUIRED so they are scoped to the verified
  // signer (no cross-agent branch/history/dirty-path leak via a spoofable
  // actorAgentId). Cross-language contract: signing.rs must mark these too.
  'git.status',
  'git.listBranches',
  'git.log',
  // Key rotation: signature-required so the rotation is proved by current-key
  // possession (paramsHash covers newPublicKeyPem, binding the new key).
  // Cross-language contract: signing.rs requires_signature() must mark this too.
  'identity.rotate',
  // Grant/revoke cross-agent root access: signature-required so only the
  // verified owner can mutate the grant list. Cross-language contract: signing.rs
  // requires_signature() must mark these too.
  'project.grant',
  'project.revoke',
  // agent.* PTY/exec surface. `agent.spawn` forks a caller-supplied command as
  // the daemon UID — an unsigned, Pro-tier-reachable RCE — and stop/input/
  // resize/output drive or read another agent's live PTY. Signature-REQUIRED so
  // the actor is the VERIFIED signer (ctx.agentId via boundVia==='signature'),
  // never a spoofable params.actorAgentId. Closes the 2026-06-29 Part B
  // unsigned-RCE + cross-agent PTY-hijack findings. Cross-language contract:
  // signing.rs requires_signature() must mark these too.
  'agent.spawn',
  'agent.stop',
  'agent.input',
  'agent.resize',
  'agent.output',
  // agent.streamTicket mints the principal for GET /api/stream (GAP-421
  // guardrail-2 remediation B1): signature-required so the ticket is bound
  // to the VERIFIED signer, and the handler re-runs agent.output's
  // owner_agent === callerAgentId check before minting. The gateway's
  // bearer token alone is a transport credential, never sufficient to read
  // PTY content.
  'agent.streamTicket',
  // agent.list returns another-agent-invisible process metadata (command, cwd),
  // and agent.remove kills + prunes a process. Both are signature-required and
  // self-scoped to the verified signer's owner_agent — an unsigned or spoofed
  // caller can neither enumerate nor prune another agent's PTYs. Cross-language
  // contract: signing.rs requires_signature() must mark these too.
  'agent.list',
  'agent.remove',
  // session.end fans out to notifyAgentEnded, which evicts the target's project
  // roots and kills every PTY it owns. It used to take a caller-supplied target
  // and sat OUTSIDE this set, so any socket peer could end an arbitrary agent's
  // session unsigned: the identity gate is satisfied by a bare `actorAgentId`
  // string, while the handler read `sessionId`. Signature-REQUIRED so the target
  // is the verified signer and nothing else. Cross-language contract: signing.rs
  // requires_signature() must mark this too.
  'session.end',
  // harness.prune reaches the SAME eviction primitive as session.end
  // (notifyAgentEnded → evictRootsForAgent + the spawn.ts PTY-kill hook), but
  // fans it out across EVERY matched session rather than one. It was
  // IDENTITY_EXEMPT and absent from this set, so a single unsigned frame from
  // any same-UID socket peer ended the whole fleet's sessions and killed every
  // PTY. `staleDays` is the amplifier: it had no floor, so 0 (or any negative,
  // which clamped to 0) selected `started_at < NOW()`, i.e. all live sessions.
  // Signature-REQUIRED, and the schema now floors both thresholds at 1 day so
  // no caller can select "everything". The periodic internal sweep is
  // unaffected: it calls runPrune directly, never through this RPC.
  // Cross-language contract: signing.rs requires_signature() must mark this too.
  // GAP-312. Sibling of the session.end fix (GAP-288, revdev#261).
  'harness.prune',
  // GAP-294 Phase 1: approval decisions are signature-required mutations.
  // Phase 2: operator mode overrides are signature-required too.
  // §9: agent-scope grant issue/revoke are operator-only mutations.
  'permission.decide',
  'permission.setMode',
  'permission.grant',
  'permission.revokeGrant',
  // gateway.revokeToken revokes an HTTP gateway bearer token (GAP-421
  // guardrail-2 remediation S5). Signature-required so an unsigned caller
  // cannot revoke another client's session.
  'gateway.revokeToken',
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
/**
 * Minimum heartbeat-idle seconds accepted on the RPC path (GAP-459 reaper).
 * Floor prevents a misconfigured client from wiping every live session the way
 * staleDays:0 once did (GAP-312). Periodic auto-prune keeps this at 0
 * (start-age path only).
 */
export const MIN_HEARTBEAT_STALE_SECONDS = 3600;

async function runPrune(
  db: PGlite,
  staleDays: number,
  hardDeleteDays: number,
  heartbeatStaleSeconds = 0,
): Promise<{ aged: number; deleted: number; heartbeatStaleSeconds: number }> {
  // Floor at ONE DAY, not zero. The previous Math.max(0, ...) let a caller pass
  // staleDays: 0 (or any negative, which clamped to 0), turning the WHERE
  // clause into `started_at < NOW()`, every live session, and fanning
  // notifyAgentEnded across the whole fleet. A zero threshold has no
  // legitimate meaning for a reaper of *stale* sessions. NaN still falls back
  // to the defaults. This is the last line of defense: the RPC schema floors
  // these too, and it also covers the env-var path
  // (REVDEV_STALE_THRESHOLD_DAYS / REVDEV_HARD_DELETE_DAYS to cfg to here).
  // GAP-312.
  const stale = Number.isFinite(staleDays) ? Math.max(1, staleDays) : 7;
  const hard = Number.isFinite(hardDeleteDays) ? Math.max(1, hardDeleteDays) : 30;
  // heartbeatStaleSeconds: 0 disables the updated_at arm (periodic default).
  // Positive values are floored at MIN_HEARTBEAT_STALE_SECONDS on the RPC path.
  const heartbeat =
    Number.isFinite(heartbeatStaleSeconds) && heartbeatStaleSeconds > 0
      ? Math.max(MIN_HEARTBEAT_STALE_SECONDS, Math.floor(heartbeatStaleSeconds))
      : 0;

  // Parameterized intervals avoid SQL injection on the thresholds.
  // Arm A: classic start-age (sessions that never ended and began long ago).
  // Arm B: heartbeat-idle (GAP-459) — no updated_at activity for $2 seconds.
  // Either arm alone is enough; exit_summary distinguishes for forensics.
  const aged = await db.query<{ id: string }>(
    `UPDATE agent_sessions
        SET ended_at = NOW(),
            exit_summary = COALESCE(
              exit_summary,
              CASE
                WHEN started_at < NOW() - INTERVAL '1 day' * $1 THEN 'pruned-stale'
                ELSE 'pruned-heartbeat'
              END
            )
      WHERE ended_at IS NULL
        AND (
          started_at < NOW() - INTERVAL '1 day' * $1
          OR (
            $2::int > 0
            AND updated_at < NOW() - make_interval(secs => $2)
          )
        )
      RETURNING id`,
    [stale, heartbeat],
  );
  // Evict filesystem roots for every stale-terminated agent (B6 item 10).
  for (const { id } of aged.rows) notifyAgentEnded(id, db);
  const deleted = await db.query<{ id: string }>(
    `DELETE FROM agent_sessions
      WHERE ended_at IS NOT NULL
        AND ended_at < NOW() - INTERVAL '1 day' * $1
      RETURNING id`,
    [hard],
  );
  // Prune stale signature telemetry events. Use the same hardDeleteDays
  // threshold: these rows are low-value after the session window closes.
  const prunedTelemetry = await db.query<{ id: number }>(
    `DELETE FROM events
      WHERE event_type = 'identity.signature_status'
        AND created_at < NOW() - INTERVAL '1 day' * $1
      RETURNING id`,
    [hard],
  );
  if (prunedTelemetry.rows.length > 0) {
    log.debug('pruned signature telemetry events', { count: prunedTelemetry.rows.length });
  }
  // Local file_reservations: drop rows past TTL (queries already filter
  // expires_at > NOW(); without this, PGlite grows unbounded).
  const expiredLocal = await db.query<{ file_path: string }>(
    `DELETE FROM file_reservations WHERE expires_at <= NOW() RETURNING file_path`,
  );
  // Neon coordination_file_claims: same TTL semantics (GAP-175). Best-effort
  // dual-write mirror; no-op when POSTGRES_URL is unset.
  const neonClaims = await sweepExpiredFileClaims();
  if (expiredLocal.rows.length > 0 || neonClaims.deleted > 0) {
    log.info('file claim TTL sweep', {
      localDeleted: expiredLocal.rows.length,
      neonDeleted: neonClaims.deleted,
    });
  }
  pruneState.lastRunAt = new Date();
  pruneState.lastAgedCount = aged.rows.length;
  pruneState.lastDeletedCount = deleted.rows.length;
  if (pruneState.lastAgedCount > 0 || pruneState.lastDeletedCount > 0) {
    log.info('prune complete', {
      aged: pruneState.lastAgedCount,
      deleted: pruneState.lastDeletedCount,
      staleDays: stale,
      hardDeleteDays: hard,
      heartbeatStaleSeconds: heartbeat,
    });
  }
  return {
    aged: pruneState.lastAgedCount,
    deleted: pruneState.lastDeletedCount,
    heartbeatStaleSeconds: heartbeat,
  };
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

const handlers = new Map<string, RpcHandler>();

/** Register an RPC method handler. */
export function registerHandler(method: string, handler: RpcHandler): void {
  handlers.set(method, handler);
}

/**
 * Returns the sorted names of every RPC method currently registered on the
 * daemon. The contract test asserts this equals the protocol's `RPC_METHODS`
 * constant, so the two lists cannot silently drift.
 */
export function listRegisteredMethods(): string[] {
  return [...handlers.keys()].sort();
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
// Active daemon config — set at startDaemon so handlers registered in other
// modules (e.g. filegit.ts) can read effective limits like
// `maxInlineReadBytes` without threading `cfg` through the handler signature.
// Null before the first startDaemon call.
// ---------------------------------------------------------------------------

let _daemonConfig: DaemonConfig | null = null;

/**
 * Returns the effective config of the running daemon. Falls back to
 * DAEMON_DEFAULTS when called before startDaemon (e.g. a handler invoked in
 * a unit test that never started a server) so callers never see `null`.
 */
export function getDaemonConfig(): DaemonConfig {
  return _daemonConfig ?? DAEMON_DEFAULTS;
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

/** Build an Error carrying the JSON-RPC -32003 "Signature required" code so the
 *  dispatch catch surfaces it verbatim (mirrors UntrustedClientKeyError). */
function signatureRequired(message: string): Error {
  const e = new Error(message) as Error & { code: number };
  e.code = -32003;
  return e;
}

/**
 * Resolve the VERIFIED security principal for a self-scoped coordination method
 * (B6 item 8). Replaces the old `requireAgent`, whose unsigned `actorAgentId`
 * fallback let agent B name agent A and read/act as them (the mail.inbox /
 * memory.query cross-agent leaks).
 *
 * Admissible principals:
 *   - A per-request Ed25519 signature (`boundVia==='signature'`). This is the
 *     ONLY admissible principal for a CLIENT-owned identity — the daemon does
 *     not hold its private key, so a valid signature is proof of possession.
 *   - A register/attach/param bind to a DAEMON-MINTED identity. The daemon
 *     mints + holds that key, so for the free/headless tier the `0600` socket
 *     bind is the trust boundary (such identities may never own filesystem
 *     roots — D2). `key_origin` is read AUTHORITATIVELY from `agent_identity`,
 *     never inferred from the call, so an attacker cannot upgrade a
 *     client-owned identity to daemon-trust by omitting `publicKeyPem`.
 *
 * Throws -32003 when no admissible principal is present. (A call with no
 * identity at all is already rejected -32002 by the dispatch identity gate
 * before any handler runs.)
 */
async function requireVerifiedAgent(
  ctx: SocketContext,
  db: PGlite,
  params?: Record<string, unknown>,
): Promise<string> {
  // A per-request signature is always admissible (key-proven possession).
  if (ctx.boundVia === 'signature' && ctx.agentId) return ctx.agentId;

  // Otherwise resolve the bound or param-named identity and trust the bind
  // ONLY when that identity is daemon-minted.
  const bound = ctx.agentId ?? (params ? strOrNull(params.actorAgentId) : null);
  if (!bound) {
    throw signatureRequired('no verified identity: sign the request or session.register first');
  }
  const origin = await db.query<{ key_origin: string }>(
    `SELECT key_origin FROM agent_identity WHERE agent_id = $1`,
    [bound],
  );
  // Unknown identity (no row yet) → treat as daemon-tier; it owns no data, so
  // there is nothing to leak, and this preserves the legacy actorAgentId bind
  // for fresh hook clients.
  const keyOrigin = origin.rows[0]?.key_origin ?? 'daemon';
  if (keyOrigin !== 'daemon') {
    throw signatureRequired(
      `client-owned identity ${bound} requires a signed request for this method`,
    );
  }
  // Daemon-minted: materialize the bind so the rest of the handler sees it.
  if (!ctx.agentId) {
    ctx.agentId = bound;
    ctx.boundVia = 'param';
  }
  ctx.keyOrigin = 'daemon';
  return bound;
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

/**
 * P2 signature-status telemetry (ADR 2026-05-16 §Q5). Emits one
 * `identity.signature_status` event per NON-EXEMPT RPC capturing whether the
 * call carried a fully-verified Ed25519 signature (`verified` / `none` /
 * `invalid`) plus whether the method already hard-requires a signature
 * (`required` = in MUTATING_OR_CONTENT_METHODS). Purely observational — it
 * changes no accept/reject behavior. Consumed during the P2 soak to measure
 * signed-coverage per agent before the P3 mandatory-enforcement flip.
 *
 * Fire-and-forget: PGlite enqueues the INSERT synchronously, so any later read
 * on the same db observes it; not awaited, so it adds no latency to the RPC.
 * A floating `.catch` swallows failures — telemetry can never throw into or
 * fail the dispatch path. `agent_id` is NOT NULL, so unauthenticated calls
 * record the `'unbound'` sentinel.
 */
function emitSignatureTelemetry(
  req: RpcRequest,
  db: PGlite,
  ctx: SocketContext,
  verification: VerificationResult,
): void {
  if (IDENTITY_EXEMPT.has(req.method)) return;
  const actor =
    ctx.agentId ??
    (req.params && typeof req.params.actorAgentId === 'string'
      ? req.params.actorAgentId
      : 'unbound');
  const payload = {
    method: req.method,
    verification,
    required: MUTATING_OR_CONTENT_METHODS.has(req.method),
  };
  db.query(`INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
    actor,
    'identity.signature_status',
    JSON.stringify(payload),
  ]).catch((err) => {
    log.debug('signature telemetry emit failed', { method: req.method, err });
  });
}

async function verifyOrWarn(
  req: RpcRequest,
  db: PGlite,
  ctx: SocketContext,
): Promise<VerificationResult> {
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
    return 'none';
  }

  const parsed = parseEnvelope(envelopeStr);
  if (!parsed) {
    log.warn('signature parse failed', { method: req.method });
    return 'invalid';
  }

  const didParsed = parseDid(parsed.payload.did);
  if (!didParsed) {
    log.warn('signature did unparseable', { did: parsed.payload.did });
    return 'invalid';
  }

  if (parsed.payload.kid !== didParsed.fingerprint) {
    log.warn('kid does not match did fingerprint', {
      kid: parsed.payload.kid,
      fingerprint: didParsed.fingerprint,
    });
    return 'invalid';
  }

  const keyRow = await db.query<{ public_key_pem: string }>(
    `SELECT public_key_pem FROM agent_identity_keys
     WHERE fingerprint = $1 AND agent_id = $2 AND superseded_at IS NULL`,
    [parsed.payload.kid, didParsed.agentId],
  );
  if (keyRow.rows.length === 0) {
    log.warn('signature unknown key', { kid: parsed.payload.kid, agentId: didParsed.agentId });
    return 'invalid';
  }

  const publicKeyPem = keyRow.rows[0]?.public_key_pem;
  if (!publicKeyPem || !verifyEnvelope(parsed, publicKeyPem)) {
    log.warn('signature invalid', { kid: parsed.payload.kid });
    return 'invalid';
  }

  if (Math.abs(Date.now() / 1000 - parsed.payload.ts) > SIG_TS_WINDOW_SECS) {
    log.warn('signature ts outside window', { ts: parsed.payload.ts });
    return 'invalid';
  }

  if (parsed.payload.method !== req.method) {
    log.warn('signature method mismatch', {
      payloadMethod: parsed.payload.method,
      reqMethod: req.method,
    });
    return 'invalid';
  }

  if (hashParams(req.method, req.params) !== parsed.payload.paramsHash) {
    log.warn('signature paramsHash mismatch', { method: req.method });
    return 'invalid';
  }

  try {
    await db.query(`INSERT INTO agent_identity_nonces (nonce, agent_id) VALUES ($1, $2)`, [
      parsed.payload.nonce,
      didParsed.agentId,
    ]);
  } catch {
    log.warn('signature nonce replay', { nonce: parsed.payload.nonce, agentId: didParsed.agentId });
    return 'invalid';
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
  return 'verified';
}

/**
 * Dispatch one already-parsed JSON-RPC request through the daemon's full
 * authorization pipeline — license guard, param validation, handler lookup,
 * Ed25519 signature gate, identity gate, permission gate, shutdown gate —
 * and run the matched handler.
 *
 * This is the single authorization path (GAP-421 daemon-ownership ADR, wire
 * path §1): both the Unix-socket loop (below, in `startDaemon`) and the HTTP
 * gateway (`http-gateway.ts`) call this exact function. Remote (HTTP) traffic
 * inherits the same license guard, typed param validation, Ed25519 signature
 * requirement on `MUTATING_OR_CONTENT_METHODS`, and permission queue as local
 * (socket) traffic — there is no parallel, weaker auth path for the network
 * surface. `ctx` is per-connection state; the socket loop reuses one `ctx`
 * across a connection's lifetime, while the HTTP gateway constructs a fresh
 * `ctx` per request (HTTP is stateless — identity for a given call comes from
 * an embedded `x-revdev-signature` envelope or a `params.actorAgentId`, never
 * from a persisted per-connection binding).
 */
export async function dispatchRpc(
  req: RpcRequest,
  db: PGlite,
  ctx: SocketContext,
): Promise<RpcResponse> {
  // License guard
  const guard = guardRpcMethod(req.method);
  if (!guard.allowed) {
    return JSON.parse(licenseErrorResponse(req.id, guard)) as RpcResponse;
  }

  // Validate params
  const validation = validateParams(req.method, req.params);
  if (!validation.valid) {
    return JSON.parse(
      invalidParamsResponse(req.id, validation.error ?? 'Invalid params'),
    ) as RpcResponse;
  }

  // Dispatch
  const handler = handlers.get(req.method);
  if (!handler) {
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    };
  }

  // Signature gate. Attempts to bind ctx.agentId from a verified Ed25519
  // envelope. For coordination methods this is accept-if-present (invalid
  // or missing signatures fall through to the identity gate below). For
  // MUTATING_OR_CONTENT_METHODS the signature is REQUIRED — anything other
  // than a fully-verified envelope is rejected with -32003 before the
  // handler runs, mirroring the license-guard block above.
  const verification = await verifyOrWarn(req, db, ctx);
  // P2 telemetry (ADR 2026-05-16 §Q5). Record the per-RPC signature status
  // for every non-exempt method BEFORE any accept/reject below, so the
  // 'none'/'invalid' coverage rate is measured across ALL non-exempt
  // traffic (the P3 flip gate). Best-effort — never blocks or fails the RPC.
  emitSignatureTelemetry(req, db, ctx, verification);
  if (MUTATING_OR_CONTENT_METHODS.has(req.method) && verification !== 'verified') {
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: {
        code: -32003,
        message: 'Signature required',
        data: {
          method: req.method,
          reason:
            verification === 'none' ? 'missing Ed25519 signature' : 'invalid Ed25519 signature',
        },
      },
    };
  }

  // Identity gate: most coordination calls need a registered agent.
  // Fallback: accept `actorAgentId` in params; requireVerifiedAgent
  // enforces the verified principal (signature, or daemon-minted bind).
  if (
    !IDENTITY_EXEMPT.has(req.method) &&
    !ctx.agentId &&
    !(req.params && typeof req.params.actorAgentId === 'string')
  ) {
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: {
        code: -32002,
        message: `Not registered: call session.register or session.attach before ${req.method}`,
      },
    };
  }

  // Permission gate (GAP-294). After identity, before shutdown/dispatch.
  // Shadow (default): would_* events only. manual/auto: enforce with
  // reject-with-receipt (-32004) + pending_approvals queue.
  {
    const agentForEvent =
      ctx.agentId ??
      (req.params && typeof req.params.actorAgentId === 'string' ? req.params.actorAgentId : null);
    // Spec §3: per-session override ?? daemon default (env).
    const mode = await resolveEffectiveMode(db, agentForEvent);
    // Shadow only when *effective* mode is shadow (session override can
    // promote a session out of daemon-default shadow for dogfood).
    if (mode === 'shadow') {
      emitPermissionShadowEvent(db, agentForEvent, req.method, evaluateShadow(req.method));
    } else {
      // Still emit would_* for soak continuity under enforce modes.
      emitPermissionShadowEvent(db, agentForEvent, req.method, evaluateShadow(req.method));
      const decision = decideEnforcement(req.method, mode);
      if (decision.action === 'deny') {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: -32004,
            message: `Permission denied for ${req.method}`,
            data: { kind: 'permission-denied', method: req.method, reason: decision.reason },
          },
        };
      }
      if (decision.action === 'require_approval') {
        if (!agentForEvent) {
          return {
            jsonrpc: '2.0',
            id: req.id,
            error: {
              code: -32002,
              message: `Not registered: call session.register before ${req.method}`,
            },
          };
        }
        const paramsObj =
          req.params && typeof req.params === 'object' && !Array.isArray(req.params)
            ? (req.params as Record<string, unknown>)
            : {};
        try {
          // Spec §9: agent-scoped mode consults operator grants before the
          // pending-approval queue (critical only by explicit method name).
          if (mode === 'agent-scoped' || decision.reason === 'agent_scoped') {
            const grantHit = await tryConsumeGrant(db, agentForEvent, req.method, paramsObj);
            if (grantHit) {
              // Covered by grant — proceed to dispatch.
            } else {
              const consumed = await tryConsumeApproval(db, agentForEvent, req.method, paramsObj);
              if (!consumed) {
                await queueApprovalRequired(db, agentForEvent, req.method, paramsObj);
              }
            }
          } else {
            const consumed = await tryConsumeApproval(db, agentForEvent, req.method, paramsObj);
            if (!consumed) {
              await queueApprovalRequired(db, agentForEvent, req.method, paramsObj);
            }
          }
        } catch (permErr) {
          if (permErr instanceof ApprovalRequiredError) {
            return {
              jsonrpc: '2.0',
              id: req.id,
              error: { code: permErr.code, message: permErr.message, data: permErr.data },
            };
          }
          throw permErr;
        }
      }
    }
  }

  // Shutdown gate. A request arriving after shutdown started must not run
  // against a closing/closed PGlite.
  if (_closing) {
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32099, message: 'Server is shutting down' },
    };
  }

  const startMs = Date.now();
  _activeHandlerCount++;
  try {
    const result = await handler(req.params ?? {}, db, ctx);
    trackRpcCall(req.method, 'ok', Date.now() - startMs);
    return { jsonrpc: '2.0', id: req.id, result };
  } catch (err) {
    trackRpcCall(req.method, 'error', Date.now() - startMs);
    // A handler may carry an explicit numeric JSON-RPC code (e.g.
    // UntrustedClientKeyError → -32004). Guard on `typeof === 'number'`
    // so Node's string error codes (ENOENT, EACCES, …) don't leak into
    // the JSON-RPC `code` field — those fall back to the generic -32000.
    const rawCode = (err as { code?: unknown }).code;
    const code = typeof rawCode === 'number' ? rawCode : -32000;
    const data = (err as { data?: unknown }).data;
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: {
        code,
        message: err instanceof Error ? err.message : 'Internal error',
        ...(data !== undefined ? { data } : {}),
      },
    };
  } finally {
    _activeHandlerCount--;
  }
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

  // Agent identity. Two ownership models:
  //   - CLIENT-OWNED (Studio zero-9P): the caller supplies `publicKeyPem` and
  //     keeps the private key in its own (Windows-local) vault. The daemon
  //     registers only the public half and never holds a private key. This is
  //     the real barrier behind the relay — a host process without the key
  //     cannot sign a mutation/content read (see MUTATING_OR_CONTENT_METHODS).
  //   - DAEMON-MINTED (headless hooks): no key supplied, so the daemon
  //     generates the keypair and returns it once in the register response.
  //     No vault mirror (GAP-409 D1) — the one-shot response and the
  //     client's local cache are the only key holders.
  const clientPublicKeyPem = strOrNull(params.publicKeyPem);
  const identity = clientPublicKeyPem
    ? await registerClientIdentity(db, id, clientPublicKeyPem)
    : await bootstrapAgentIdentity(db, id);
  const { did, publicKeyPem } = identity;

  // Run the registered session-lifecycle advisory checks and surface their
  // warnings to the client. Best-effort by construction: runSessionChecks
  // catches per-check throws and always resolves, so registration can never
  // fail on a check error.
  const warnings = await runSessionChecks({ workDir, agentId: id });

  // Include `session: {id}` for back-compat with hook clients that read
  // `result.session.id`. New clients should use `sessionId`/`agentId`.
  //
  // `privateKeyPem` is returned ONLY on first daemon-minted bootstrap so
  // headless harness clients can cache a signing key for session.end and
  // other MUTATING_OR_CONTENT_METHODS. Consumers include Claude Code hooks,
  // Grok dual-harness hooks, Ubuntu Inference Snap / Ollama agents registered
  // from Studio, and the MCP bridge — not Claude/Grok alone. Client-owned
  // enroll never returns a private key (Studio UI keeps it). Re-register of
  // an existing identity never re-emits the private key — clients load it
  // from their local cache (there is no vault mirror; GAP-409 D1-D3).
  return {
    sessionId: id,
    agentId: id,
    agentName,
    backend,
    did,
    publicKeyPem,
    ...(identity.privateKeyPem !== undefined ? { privateKeyPem: identity.privateKeyPem } : {}),
    warnings,
    session: { id, env, task: workDir },
  };
});

interface IdentityResult {
  did: string;
  publicKeyPem: string;
  /**
   * Present only when this call freshly minted a daemon-held keypair.
   * Never on client-owned enroll or re-register of an existing identity.
   */
  privateKeyPem?: string;
}

async function bootstrapAgentIdentity(db: PGlite, agentId: string): Promise<IdentityResult> {
  const existing = await db.query<{ did: string; fingerprint: string; public_key_pem: string }>(
    `SELECT did, fingerprint, public_key_pem FROM agent_identity WHERE agent_id = $1`,
    [agentId],
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as { did: string; fingerprint: string; public_key_pem: string };
    return { did: row.did, publicKeyPem: row.public_key_pem };
  }

  // First registration — generate a new keypair.
  const kp = generateAgentKeypair();
  const fingerprint = computeFingerprint(kp.publicKeyRaw);
  const did = formatDid(agentId, fingerprint);

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

  // No vault mirror (GAP-409 D1): the one-shot privateKeyPem response and the
  // client's local cache are the ONLY key holders. Session-keyed identities
  // are ephemeral; mirroring them into revvault only accumulated dead
  // per-session entries (and polluted the production store from test runs).
  // Lost-both recovery is deliberately absent (D3/D4): re-register a fresh
  // session identity instead.
  return { did, publicKeyPem: kp.publicKeyPem, privateKeyPem: kp.privateKeyPem };
}

/** Thrown when a client (agentId, key) pair is not in the trust anchor. */
class UntrustedClientKeyError extends Error {
  /** JSON-RPC error code surfaced to the client (see dispatch catch). */
  readonly code = -32004;
  constructor(agentId: string, fingerprint: string, anchorPath: string) {
    super(
      `untrusted client identity: (agentId ${agentId}, fingerprint ${fingerprint}) is not in ` +
        `the trust anchor ${anchorPath}. A client identity may only be enrolled for the ` +
        `install-provisioned (agentId, key) pair. If this is a fresh install, run the Studio ` +
        `daemon setup to provision it.`,
    );
    this.name = 'UntrustedClientKeyError';
  }
}

/**
 * Read the trust anchor and return the set of allowed `agentId:fingerprint`
 * pairs. One `agentId:fingerprint` per line; blank lines and `#` comments are
 * ignored. Binding the agentId — not just the fingerprint — stops a single
 * trusted key from enrolling under arbitrary agentIds and becoming many owning
 * agents, which would defeat per-agent root scoping (review B-3).
 *
 * A missing / unreadable / UNTRUSTED file yields an EMPTY set — enrollment then
 * fails closed. When `requireRootOwned` (production, review B-2), the file AND
 * every ancestor directory must be a root-owned, non-symlink entry with no
 * group/other write bit, and the file is opened O_NOFOLLOW + fstat-checked
 * ("root-owned" = confinement's `isTrustedRootOwner`: uid 0, or uid 65534 only
 * under the proven WSL systemd-user idmap squash — GAP-409 D7). So a WSL-user
 * attacker cannot point the daemon at a file they control, even via
 * a systemd-user `Environment=REVDEV_DAEMON_TRUSTED_CLIENT_FP=...` override
 * (their path is not root-owned, so it is rejected). The disable lives ONLY in
 * the programmatic startDaemon config (tests), never in an env var an attacker
 * could set on their own --user unit.
 */
async function loadTrustedClientEntries(
  anchorPath: string,
  requireRootOwned: boolean,
): Promise<Set<string>> {
  let text: string;
  try {
    text = requireRootOwned
      ? await readRootOwnedFile(anchorPath)
      : await readFile(anchorPath, 'utf8');
  } catch (err) {
    log.warn('trust anchor unreadable/untrusted — client-key enrollment fails closed', {
      anchorPath,
      requireRootOwned,
      reason: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    // Require a non-empty agentId AND fingerprint on either side of the colon.
    if (idx <= 0 || idx >= trimmed.length - 1) continue;
    out.add(`${trimmed.slice(0, idx)}:${trimmed.slice(idx + 1)}`);
  }
  return out;
}

/**
 * Register a CLIENT-supplied Ed25519 public key for an agent (Studio zero-9P
 * model). The daemon derives the fingerprint + DID from the SPKI PEM and
 * stores ONLY the public half in agent_identity / agent_identity_keys — no
 * private key is generated or written to revvault. Idempotent: re-registering
 * the same key is a no-op; a different key rotates (supersedes the prior one).
 *
 * SECURITY: the supplied key's fingerprint MUST appear in the root-owned trust
 * anchor or enrollment is rejected (-32004). This closes the self-enrollment
 * hole (any process reaching the 0600 socket could previously enroll its own
 * key) AND the key-takeover hole (supplying a different key for an existing
 * agentId previously SUPERSEDED the legitimate key). The check runs on every
 * path — fresh insert, rotation, and the idempotent re-register — so an
 * untrusted key can never enter agent_identity_keys.
 */
async function registerClientIdentity(
  db: PGlite,
  agentId: string,
  publicKeyPem: string,
): Promise<IdentityResult> {
  const raw = spkiPemToRaw(publicKeyPem);
  const fingerprint = computeFingerprint(raw);
  const did = formatDid(agentId, fingerprint);

  // Trust-anchor gate (fail-closed). Reject unless THIS (agentId, fingerprint)
  // pair is provisioned, BEFORE touching agent_identity_keys. Binding the
  // agentId stops one trusted key from minting unlimited owning agents (B-3).
  const cfg = getDaemonConfig();
  const trusted = await loadTrustedClientEntries(
    cfg.trustedClientFingerprintPath,
    cfg.trustedAnchorRequireRootOwned,
  );
  if (!trusted.has(`${agentId}:${fingerprint}`)) {
    throw new UntrustedClientKeyError(agentId, fingerprint, cfg.trustedClientFingerprintPath);
  }

  const existing = await db.query<{ fingerprint: string }>(
    `SELECT fingerprint FROM agent_identity WHERE agent_id = $1`,
    [agentId],
  );

  if (existing.rows.length === 0) {
    await db.query(
      `INSERT INTO agent_identity (agent_id, did, fingerprint, public_key_pem, key_origin)
       VALUES ($1, $2, $3, $4, 'client')`,
      [agentId, did, fingerprint, publicKeyPem],
    );
    await db.query(
      `INSERT INTO agent_identity_keys (fingerprint, agent_id, public_key_pem)
       VALUES ($1, $2, $3)`,
      [fingerprint, agentId, publicKeyPem],
    );
  } else if (existing.rows[0]?.fingerprint !== fingerprint) {
    // Key rotation must go through identity.rotate (requires a per-request
    // signature from the current key as proof-of-possession). Reaching here
    // means a different key was supplied without that signed rotate call.
    throw new Error(
      `identity ${agentId} is already enrolled with a different key — use identity.rotate to change keys`,
    );
  }
  // else: same fingerprint already registered — idempotent no-op.

  return { did, publicKeyPem };
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

// -- Session activity-state (GAP-257) ---------------------------------------
//
// A session blocked on an unanswered permission prompt is, in the raw
// `agent_sessions` shape, byte-identical to one actively working. `state`
// makes that distinction explicit (Signal 1), and the active-window
// derivation below is the heartbeat fallback (Signal 2): a blocked session
// stops emitting PostToolUse, so its `updated_at` ages past the window and it
// drops out of "active" even when Signal 1 never fired (older CLI, disabled
// hook, wedged process). The seconds-scale liveness window is independent of
// the days-scale GAP-153 stale-prune.
const VALID_ACTIVITY_STATES = new Set(['active', 'blocked', 'idle']);
const ACTIVE_WINDOW_SECONDS = (() => {
  const raw = Number(process.env.REVDEV_ACTIVE_WINDOW_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120;
})();

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
  // `active` + `staleSeconds` are derived SERVER-SIDE (NOW() vs updated_at)
  // so the comparison never depends on the client clock or on JS parsing a
  // naive PGlite TIMESTAMP — the same NOW()-relative basis the GAP-153 prune
  // uses. Quoted alias preserves the camelCase `staleSeconds` key.
  const result = await db.query<Record<string, unknown>>(
    `SELECT *,
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - updated_at))))::int AS "staleSeconds",
            (activity_state = 'active'
             AND updated_at > NOW() - make_interval(secs => $1)) AS active
       FROM agent_sessions
      WHERE ended_at IS NULL
      ORDER BY started_at DESC`,
    [ACTIVE_WINDOW_SECONDS],
  );
  return { sessions: result.rows, scope: 'local', activeWindowSeconds: ACTIVE_WINDOW_SECONDS };
});

registerHandler('session.end', async (params, db, ctx) => {
  // Self-scoped to the VERIFIED signer. session.end is in
  // MUTATING_OR_CONTENT_METHODS, so the dispatch gate has already bound
  // ctx.agentId via boundVia==='signature' before this runs; the check below is
  // the defense-in-depth backstop, mirroring agent.spawn's requireAgent.
  //
  // The old `params.sessionId ?? params.agentId` override ("admin cleanup") had
  // NO caller: harness.prune reaps aged sessions by calling notifyAgentEnded
  // directly, and every real caller passes its own id. It existed only as the
  // attack surface, so it is gone rather than gated behind an unused admin role.
  if (ctx.boundVia !== 'signature' || !ctx.agentId) {
    throw new Error(
      'session.end requires a signed request (verified Ed25519 signature); unsigned or param-bound actor rejected',
    );
  }
  const target = ctx.agentId;
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
  // Evict all filesystem roots owned by this agent (B6 item 10).
  notifyAgentEnded(target, db);
  // Best-effort dual-write — see GAP-154 §E.
  await syncSessionEnd({ sessionId: target, summary: exitSummary });
  return { ended: target };
});

registerHandler('session.update', async (params, db, ctx) => {
  const target = strOrNull(params.sessionId) ?? strOrNull(params.agentId) ?? ctx.agentId;
  if (!target) throw new Error('No session to update');
  const task = strOrNull(params.task);
  const files = strOrNull(params.files);

  // Activity-state (GAP-257) is SELF-SCOPED: it mutates the caller's OWN
  // bound session (ctx.agentId) ONLY — never the caller-supplied `target`
  // override. Routing `state` through `target` (params.sessionId/agentId)
  // would recreate the cross-agent eviction hole session.end carries (MED,
  // 2026-06-28 agent.* review) — here a cross-agent liveness/coordination
  // DoS (any socket-reachable caller marks a PEER 'blocked'/'idle'). The
  // pre-existing task/files override is unchanged and remains separately
  // tracked. Validate up-front so a bad/unbound state call throws before
  // any DB write.
  const state = strOrNull(params.state);
  if (state !== null) {
    if (!ctx.agentId) {
      throw new Error(
        'session.update: state change requires a bound session — register/attach/sign first',
      );
    }
    if (!VALID_ACTIVITY_STATES.has(state)) {
      throw new Error(`session.update: invalid state '${state}' (active|blocked|idle)`);
    }
  }

  // Build the task/files update dynamically but keep values parameterized.
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

  // State mutation — separate statement, scoped to ctx.agentId ONLY.
  // `blocked_since` is server-authoritative (NOW(), preserved across repeat
  // 'blocked' calls via COALESCE) and cleared on any non-blocked state, so
  // it's never trusted from the caller's clock.
  if (state !== null && ctx.agentId) {
    const blockedReason =
      state === 'blocked' ? (strOrNull(params.blockedReason) ?? 'permission') : null;
    await db.query(
      `UPDATE agent_sessions
          SET activity_state = $1,
              blocked_reason = $2,
              blocked_since  = CASE WHEN $1 = 'blocked'
                                    THEN COALESCE(blocked_since, NOW())
                                    ELSE NULL END,
              updated_at     = NOW()
        WHERE id = $3`,
      [state, blockedReason, ctx.agentId],
    );
  }

  // Best-effort dual-write — task is the only column the Neon-side
  // session row exposes from the daemon's update; files / updated_at
  // are daemon-only concerns. See GAP-154 §E.
  if (task !== null) {
    await syncSessionUpdate({ sessionId: target, task });
  }
  return state !== null ? { updated: target, stateScopedTo: ctx.agentId } : { updated: target };
});

// -- Identity ---------------------------------------------------------------

registerHandler('identity.rotate', async (params, db, ctx) => {
  // Require a per-request signature from the CURRENT key (proof-of-possession).
  // requireVerifiedAgent throws -32003 for unsigned or daemon-minted callers.
  const agentId = await requireVerifiedAgent(ctx, db, params);

  const newPublicKeyPem = strOrNull(params.newPublicKeyPem);
  if (!newPublicKeyPem) throw new Error('identity.rotate: missing newPublicKeyPem');

  const raw = spkiPemToRaw(newPublicKeyPem);
  const newFingerprint = computeFingerprint(raw);
  const newDid = formatDid(agentId, newFingerprint);

  // Trust-anchor gate — the new key must be provisioned before replacing the old one.
  const cfg = getDaemonConfig();
  const trusted = await loadTrustedClientEntries(
    cfg.trustedClientFingerprintPath,
    cfg.trustedAnchorRequireRootOwned,
  );
  if (!trusted.has(`${agentId}:${newFingerprint}`)) {
    throw new UntrustedClientKeyError(agentId, newFingerprint, cfg.trustedClientFingerprintPath);
  }

  // Supersede the old active key and register the new one.
  await db.query(
    `UPDATE agent_identity_keys SET superseded_at = NOW()
     WHERE agent_id = $1 AND superseded_at IS NULL`,
    [agentId],
  );
  await db.query(
    `INSERT INTO agent_identity_keys (fingerprint, agent_id, public_key_pem)
     VALUES ($1, $2, $3)`,
    [newFingerprint, agentId, newPublicKeyPem],
  );
  await db.query(
    `UPDATE agent_identity
     SET did = $1, fingerprint = $2, public_key_pem = $3, key_origin = 'client', last_seen_at = NOW()
     WHERE agent_id = $4`,
    [newDid, newFingerprint, newPublicKeyPem, agentId],
  );

  return { did: newDid, publicKeyPem: newPublicKeyPem };
});

// -- Mail -------------------------------------------------------------------

registerHandler('mail.send', async (params, db, ctx) => {
  const from = await requireVerifiedAgent(ctx, db, params);
  const to = strOrNull(params.to) ?? strOrNull(params.toAgent);
  if (!to) throw new Error('mail.send: missing "to" (or "toAgent")');
  const subject = str(params.subject);
  const body = str(params.body);
  // GAP-176: generate UUID once; dual-write the same id to Neon.
  const id = crypto.randomUUID();

  await db.query(
    `INSERT INTO agent_messages (id, from_agent, to_agent, subject, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, from, to, subject, body],
  );
  // Best-effort dual-write to coordination_mail (GAP-154 Phase 3 + GAP-176).
  await syncMailSend({ id, fromAgent: from, toAgent: to, subject, body });
  return { sent: true, id };
});

registerHandler('mail.inbox', async (params, db, ctx) => {
  // B6 item 6: the principal is the VERIFIED caller only — the prior
  // agentId-param override let any caller read another agent's inbox.
  const agentId = await requireVerifiedAgent(ctx, db, params);
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
  const from = await requireVerifiedAgent(ctx, db, params);
  const subject = str(params.subject);
  const body = str(params.body);

  const sessions = await db.query<{ id: string }>(
    `SELECT id FROM agent_sessions WHERE ended_at IS NULL AND id <> $1`,
    [from],
  );
  const neonRows: Array<{ id: string; toAgent: string; subject: string; body: string }> = [];
  for (const target of sessions.rows) {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO agent_messages (id, from_agent, to_agent, subject, body)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, from, target.id, subject, body],
    );
    neonRows.push({ id, toAgent: target.id, subject, body });
  }
  // Best-effort dual-write to coordination_mail (GAP-154 Phase 3 + GAP-176).
  await syncMailBroadcast({ fromAgent: from, rows: neonRows });
  return { broadcast: true, sent: sessions.rows.length, recipients: sessions.rows.length };
});

registerHandler('mail.markRead', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
  // GAP-176: ids are UUID strings (legacy numeric ids no longer match after
  // migration 0009 — clients must re-read inbox for new ids).
  const raw = Array.isArray(params.messageIds) ? params.messageIds : [];
  const ids = raw
    .map((v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''))
    .filter((s) => s.length > 0);
  if (ids.length === 0) return { marked: 0 };

  const result = await db.query(
    `UPDATE agent_messages SET read = TRUE
     WHERE to_agent = $1 AND id = ANY($2::text[])`,
    [agentId, ids],
  );
  // Best-effort dual-write by shared UUID (GAP-176).
  await syncMailMarkRead({ reader: agentId, ids });
  return { marked: result.affectedRows ?? ids.length };
});

// -- File reservations ------------------------------------------------------

registerHandler('files.reserve', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
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

  // Best-effort dual-write to coordination_file_claims (GAP-154 Phase 3 +
  // GAP-175 expires_at). Only sync paths actually reserved (not conflicts).
  // reason stays PGlite-only; Neon TTL is swept by sweepExpiredFileClaims.
  if (reserved.length > 0) {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await syncFilesReserve({ sessionId: agentId, paths: reserved, expiresAt });
  }
  return {
    success: conflicts.length === 0,
    reserved,
    conflicts,
  };
});

registerHandler('files.check', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
  const paths = normalizePaths(params);
  if (paths.length === 0) return { reservations: [], reservedByOther: false };
  const result = await db.query<Record<string, unknown>>(
    `SELECT file_path, agent_id, reserved_at, expires_at, reason
     FROM file_reservations
     WHERE file_path = ANY($1::text[]) AND expires_at > NOW()`,
    [paths],
  );
  // B6 item 6: surface only the caller's OWN reservations in full; collapse
  // others to a boolean so B cannot learn who/why A reserved a path.
  const own = result.rows.filter((r) => r.agent_id === agentId);
  const reservedByOther = result.rows.some((r) => r.agent_id !== agentId);
  return { reservations: own, reservedByOther };
});

registerHandler('files.release', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
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

registerHandler('files.list', async (params, db, ctx) => {
  // B6 item 6: scope to the verified caller's own reservations. Cross-agent
  // enumeration was a side channel (which paths another agent is working on).
  const agentId = await requireVerifiedAgent(ctx, db, params);
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM file_reservations WHERE expires_at > NOW() AND agent_id = $1
     ORDER BY reserved_at DESC`,
    [agentId],
  );
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

registerHandler('tasks.list', async (params, db, ctx) => {
  const status = strOrNull(params.status);
  const ownerParam = strOrNull(params.owner);

  const where: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (status && status !== 'all') {
    where.push(`status = $${i++}`);
    vals.push(status);
  }
  // B6 item 6: the open/unclaimed pool is globally visible (a coordination
  // feature), but filtering by a SPECIFIC owner's claimed tasks must be the
  // caller themselves — else B enumerates A's task assignments.
  if (ownerParam) {
    const verified = await requireVerifiedAgent(ctx, db, params);
    if (ownerParam !== verified) {
      throw signatureRequired('tasks.list owner filter is restricted to the calling agent');
    }
    where.push(`owner = $${i++}`);
    vals.push(ownerParam);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM tasks ${whereClause} ORDER BY created_at DESC`,
    vals,
  );
  return { tasks: result.rows };
});

registerHandler('tasks.claim', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
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
  const agentId = await requireVerifiedAgent(ctx, db, params);
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
    // GAP-362: durable work.completed + in-process notify (auto-notify over poll)
    let eventId: number | null = null;
    try {
      const ins = await db.query<{ id: number }>(
        `INSERT INTO events (agent_id, event_type, payload)
         VALUES ($1, $2, $3::jsonb)
         RETURNING id`,
        [agentId, WORK_COMPLETED_EVENT, JSON.stringify({ taskId, summary: summary ?? null })],
      );
      eventId =
        typeof ins.rows[0]?.id === 'number' ? ins.rows[0].id : Number(ins.rows[0]?.id ?? 0) || null;
      await syncEventLog({
        agentId,
        type: WORK_COMPLETED_EVENT,
        payload: { taskId, summary: summary ?? null },
      });
    } catch {
      /* event dual-write is best-effort */
    }
    workEvents.emitCompleted({
      taskId,
      agentId,
      summary: summary ?? null,
      eventId,
      at: new Date().toISOString(),
    });
  }
  return { ok, completed: ok ? taskId : null };
});

registerHandler('tasks.release', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
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

// -- Goals (roadmap-goal-spine PR0) ------------------------------------------

function goalHarness(db: PGlite, agentId: string): GoalHarness {
  return new GoalHarness({ store: new GoalStore(db), agentId });
}

registerHandler('goal.create', async (params, db, ctx) => {
  const agentId = strOrNull(params.agentId) ?? ctx.agentId ?? 'anonymous';
  const harness = goalHarness(db, agentId);
  const result = await harness.createGoal({
    id: strOrNull(params.id) ?? undefined,
    title: str(params.title),
    description: str(params.description, ''),
    priority:
      (strOrNull(params.priority) as 'blocker' | 'high' | 'medium' | 'low' | null) ?? undefined,
    owner: (strOrNull(params.owner) as 'agent' | 'human' | null) ?? undefined,
    parentGoalId: strOrNull(params.parentGoalId) ?? undefined,
    blockedBy: Array.isArray(params.blockedBy)
      ? (params.blockedBy as unknown[]).map((v) => String(v))
      : [],
    criteria: Array.isArray(params.criteria)
      ? (params.criteria as unknown[]).map((v) => String(v))
      : [],
  });
  return result;
});

registerHandler('goal.get', async (params, db, ctx) => {
  const agentId = strOrNull(params.agentId) ?? ctx.agentId ?? 'anonymous';
  const goalId = strOrNull(params.goalId) ?? strOrNull(params.id);
  if (!goalId) throw new Error('goal.get: missing goalId');
  const result = await goalHarness(db, agentId).getGoal(goalId);
  return { goal: result };
});

registerHandler('goal.list', async (params, db, ctx) => {
  const agentId = strOrNull(params.agentId) ?? ctx.agentId ?? 'anonymous';
  const goals = await goalHarness(db, agentId).listGoals({
    status:
      (strOrNull(params.status) as 'open' | 'active' | 'blocked' | 'done' | 'abandoned' | null) ??
      undefined,
    priority:
      (strOrNull(params.priority) as 'blocker' | 'high' | 'medium' | 'low' | null) ?? undefined,
    owner: (strOrNull(params.owner) as 'agent' | 'human' | null) ?? undefined,
    parentGoalId: strOrNull(params.parentGoalId) ?? undefined,
  });
  return { goals };
});

registerHandler('goal.setStatus', async (params, db, ctx) => {
  const agentId = strOrNull(params.agentId) ?? ctx.agentId ?? 'anonymous';
  const goalId = strOrNull(params.goalId) ?? strOrNull(params.id);
  if (!goalId) throw new Error('goal.setStatus: missing goalId');
  const status = str(params.status);
  const reason = str(params.reason, '');
  const harness = goalHarness(db, agentId);
  if (status === 'active') return harness.activateGoal(goalId);
  if (status === 'blocked') return harness.blockGoal(goalId, reason || 'blocked');
  if (status === 'abandoned') return harness.abandonGoal(goalId, reason || 'abandoned');
  if (status === 'done') return harness.completeGoal(goalId);
  throw new Error(`goal.setStatus: unsupported status '${status}'`);
});

registerHandler('goal.addCriterion', async (params, db, ctx) => {
  const agentId = strOrNull(params.agentId) ?? ctx.agentId ?? 'anonymous';
  const goalId = strOrNull(params.goalId);
  if (!goalId) throw new Error('goal.addCriterion: missing goalId');
  const description = str(params.description);
  return goalHarness(db, agentId).addCriterion(goalId, description);
});

registerHandler('goal.recordCriterion', async (params, db, ctx) => {
  const agentId = strOrNull(params.agentId) ?? ctx.agentId ?? 'anonymous';
  const criterionId = strOrNull(params.criterionId) ?? strOrNull(params.id);
  if (!criterionId) throw new Error('goal.recordCriterion: missing criterionId');
  const verdictRaw = str(params.verdict, 'met');
  if (verdictRaw !== 'met' && verdictRaw !== 'failed') {
    throw new Error("goal.recordCriterion: verdict must be 'met' or 'failed'");
  }
  const evidence = str(params.evidence, '');
  return goalHarness(db, agentId).recordCriterion(criterionId, verdictRaw, evidence);
});

registerHandler('goal.listCriteria', async (params, db) => {
  const goalId = strOrNull(params.goalId);
  if (!goalId) throw new Error('goal.listCriteria: missing goalId');
  const criteria = await new GoalStore(db).listGoalCriteria(goalId);
  return { criteria };
});

registerHandler('goal.progress', async (params, db, ctx) => {
  const agentId = strOrNull(params.agentId) ?? ctx.agentId ?? 'anonymous';
  const goalId = strOrNull(params.goalId) ?? strOrNull(params.id);
  if (!goalId) throw new Error('goal.progress: missing goalId');
  const progress = await goalHarness(db, agentId).progress(goalId);
  return { progress };
});

registerHandler('goal.nextActions', async (params, db, ctx) => {
  const agentId = strOrNull(params.agentId) ?? ctx.agentId ?? 'anonymous';
  const goalId = strOrNull(params.goalId) ?? strOrNull(params.id);
  if (!goalId) throw new Error('goal.nextActions: missing goalId');
  const actions = await goalHarness(db, agentId).nextActions(goalId);
  return { actions };
});

registerHandler('goal.proposeTask', async (params, db, ctx) => {
  const agentId = strOrNull(params.agentId) ?? ctx.agentId ?? 'anonymous';
  const criterionId = strOrNull(params.criterionId);
  if (!criterionId) throw new Error('goal.proposeTask: missing criterionId');
  return goalHarness(db, agentId).proposeTaskForCriterion(criterionId);
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
  // GAP-307: fold liveness into the existing high-frequency tool-use path.
  // track-tools.js already logs tool-use after every tool with
  // payload.sessionId = daemon session id cache. Bump updated_at so
  // session.list's server-side `active` window reflects real work without a
  // new RPC or a new hook process.
  if (eventType === 'tool-use') {
    const payloadObj =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const sessionKey =
      (typeof payloadObj.sessionId === 'string' && payloadObj.sessionId) ||
      (agentId !== 'anonymous' ? agentId : null);
    if (sessionKey) {
      void db
        .query(
          `UPDATE agent_sessions
              SET updated_at = NOW()
            WHERE id = $1 AND ended_at IS NULL`,
          [sessionKey],
        )
        .catch(() => {
          /* non-fatal — liveness is best-effort */
        });
    }
  }
  // Best-effort dual-write to coordination_events (GAP-154 Phase 3).
  await syncEventLog({ agentId, type: eventType, payload });
  return { logged: true };
});

registerHandler('events.query', async (params, db) => {
  const limit = Math.min(num(params.limit, 20), 500);
  const since = strOrNull(params.since);
  const eventType = strOrNull(params.eventType);
  const where: string[] = [];
  const args: unknown[] = [];
  let p = 1;
  if (since) {
    where.push(`created_at > $${p++}::timestamp`);
    args.push(since);
  }
  if (eventType) {
    where.push(`event_type = $${p++}`);
    args.push(eventType);
  }
  args.push(limit);
  const sql =
    where.length > 0
      ? `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${p}`
      : `SELECT * FROM events ORDER BY created_at DESC LIMIT $1`;
  const result = await db.query<Record<string, unknown>>(sql, args);
  return { events: result.rows };
});

// GAP-362: long-poll for an event type (e.g. work.completed) — prefer this over
// client-side sub-minute polling of events.query.
registerHandler('events.wait', async (params, db, ctx) => {
  await requireVerifiedAgent(ctx, db, params);
  const eventType = str(params.eventType);
  const sinceId = num(params.sinceId, 0);
  const timeoutMs = Math.min(Math.max(num(params.timeoutMs, 30_000), 100), 120_000);
  const deadline = Date.now() + timeoutMs;

  const pollOnce = async () => {
    const result = await db.query<Record<string, unknown>>(
      `SELECT * FROM events
        WHERE event_type = $1 AND id > $2
        ORDER BY id ASC
        LIMIT 1`,
      [eventType, sinceId],
    );
    return result.rows[0] ?? null;
  };

  let row = await pollOnce();
  if (row) return { event: row, timedOut: false };

  // Race the in-process bus for hot event types (work.completed, design.pack.moved)
  // to avoid missing the row under test/driver lag (still falls back to DB poll).
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      workEvents.off(WORK_COMPLETED_EVENT, onBus);
      designPackEvents.off(DESIGN_PACK_MOVED_EVENT, onBus);
      resolve();
    };
    const onBus = () => {
      void pollOnce().then((r) => {
        if (r) {
          row = r;
          finish();
        }
      });
    };
    if (eventType === WORK_COMPLETED_EVENT) {
      workEvents.on(WORK_COMPLETED_EVENT, onBus);
    }
    if (eventType === DESIGN_PACK_MOVED_EVENT) {
      designPackEvents.on(DESIGN_PACK_MOVED_EVENT, onBus);
    }
    const timer = setInterval(() => {
      if (Date.now() >= deadline) {
        finish();
        return;
      }
      void pollOnce().then((r) => {
        if (r) {
          row = r;
          finish();
        }
      });
    }, 100);
  });

  if (row) return { event: row, timedOut: false };
  return { event: null, timedOut: true };
});

// -- Loop guard (GAP-362 token-economy) --------------------------------------

registerHandler('loop.arm', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
  const loopId = str(params.loopId);
  const intervalMs = num(params.intervalMs, 0);
  const noopLimit = params.noopLimit === undefined ? undefined : num(params.noopLimit, 3);
  const state = loopGuards.arm({
    loopId,
    agentId,
    intervalMs,
    noopLimit,
  });
  return { loop: state };
});

registerHandler('loop.tick', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
  const loopId = str(params.loopId);
  const advanced = params.advanced === true;
  const tokensIn = params.tokensIn === undefined ? undefined : num(params.tokensIn, 0);
  const tokensOut = params.tokensOut === undefined ? undefined : num(params.tokensOut, 0);
  const costMicros = params.costMicros === undefined ? undefined : num(params.costMicros, 0);
  const existing = loopGuards.get(loopId);
  if (existing && existing.agentId !== agentId) {
    throw new Error(`loop ${loopId} is owned by another agent`);
  }
  const state = loopGuards.tick({
    loopId,
    advanced,
    tokensIn,
    tokensOut,
    costMicros,
  });
  // Durable spend sample on the event log (queryable; pairs with process-local spend)
  if (tokensIn || tokensOut || costMicros) {
    try {
      await db.query(
        `INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`,
        [
          agentId,
          'loop.spend_delta',
          JSON.stringify({
            loopId,
            tokensIn: tokensIn ?? 0,
            tokensOut: tokensOut ?? 0,
            costMicros: costMicros ?? 0,
            cumulative: state.spend,
          }),
        ],
      );
    } catch {
      /* best-effort */
    }
  }
  if (state.status === 'not_advancing') {
    await db.query(
      `INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`,
      [
        agentId,
        'loop.not_advancing',
        JSON.stringify({
          loopId,
          consecutiveNoOps: state.consecutiveNoOps,
          noopLimit: state.noopLimit,
          signal: state.lastSignal,
          spend: state.spend,
        }),
      ],
    );
  }
  return { loop: state };
});

registerHandler('loop.status', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
  const loopId = str(params.loopId);
  const state = loopGuards.get(loopId);
  if (!state) return { loop: null };
  if (state.agentId !== agentId) throw new Error(`loop ${loopId} is owned by another agent`);
  return { loop: state };
});

registerHandler('loop.spend', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
  const loopId = str(params.loopId);
  const state = loopGuards.get(loopId);
  if (!state) return { loopId, spend: null };
  if (state.agentId !== agentId) throw new Error(`loop ${loopId} is owned by another agent`);
  return { loopId, spend: state.spend, tickCount: state.tickCount, status: state.status };
});

registerHandler('loop.record_spend', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
  const loopId = str(params.loopId);
  const existing = loopGuards.get(loopId);
  if (!existing) throw new Error(`unknown loopId: ${loopId}`);
  if (existing.agentId !== agentId) throw new Error(`loop ${loopId} is owned by another agent`);
  const tokensIn = params.tokensIn === undefined ? undefined : num(params.tokensIn, 0);
  const tokensOut = params.tokensOut === undefined ? undefined : num(params.tokensOut, 0);
  const costMicros = params.costMicros === undefined ? undefined : num(params.costMicros, 0);
  const state = loopGuards.recordSpend({ loopId, tokensIn, tokensOut, costMicros });
  try {
    await db.query(
      `INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`,
      [
        agentId,
        'loop.spend_delta',
        JSON.stringify({
          loopId,
          tokensIn: tokensIn ?? 0,
          tokensOut: tokensOut ?? 0,
          costMicros: costMicros ?? 0,
          cumulative: state.spend,
        }),
      ],
    );
  } catch {
    /* best-effort */
  }
  return { loop: state };
});

registerHandler('loop.pause', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
  const loopId = str(params.loopId);
  const existing = loopGuards.get(loopId);
  if (!existing) throw new Error(`unknown loopId: ${loopId}`);
  if (existing.agentId !== agentId) throw new Error(`loop ${loopId} is owned by another agent`);
  return { loop: loopGuards.pause(loopId) };
});

registerHandler('loop.resume', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
  const loopId = str(params.loopId);
  const existing = loopGuards.get(loopId);
  if (!existing) throw new Error(`unknown loopId: ${loopId}`);
  if (existing.agentId !== agentId) throw new Error(`loop ${loopId} is owned by another agent`);
  return { loop: loopGuards.resume(loopId) };
});

registerHandler('loop.stop', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
  const loopId = str(params.loopId);
  const existing = loopGuards.get(loopId);
  if (!existing) throw new Error(`unknown loopId: ${loopId}`);
  if (existing.agentId !== agentId) throw new Error(`loop ${loopId} is owned by another agent`);
  return { loop: loopGuards.stop(loopId) };
});

// -- Peer context (GAP-459 Phase 1) -----------------------------------------
//
// Composite advisory snapshot so harnesses can paint peer presence, claims,
// and active paths in ONE call. Does not invent a third store: composes
// agent_sessions + file_reservations + tasks + events (peer.* types).
// Autonomy rule (ADR 2026-07-28): this is awareness only — never a lock.
// Unavailable clients must degrade VISIBLY (adapters print WARN), never
// silently pretend peers are absent when the daemon is down.

registerHandler('context.snapshot', async (params, db, ctx) => {
  const eventLimit = Math.min(num(params.eventLimit, 50), 200);
  const includeSelf = params.includeSelf === true;
  // Prefer bound identity so we can label self vs peers. Unsigned callers
  // with no actor still get a fleet-wide snapshot (selfAgentId null).
  const selfAgentId =
    (ctx.agentId && String(ctx.agentId)) || strOrNull(params.actorAgentId) || null;

  // agent_sessions columns: id (also the agent identity), env, task, files,
  // activity_state (migration 0005), timestamps. No separate agent_name col —
  // name is encoded in env as `${backend}:${agentName}` at register time.
  const sessionsResult = await db.query<Record<string, unknown>>(
    `SELECT id, env, task, files, activity_state, pid, started_at, updated_at,
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - updated_at))))::int AS "staleSeconds",
            (activity_state = 'active'
             AND updated_at > NOW() - make_interval(secs => $1)) AS active
       FROM agent_sessions
      WHERE ended_at IS NULL
      ORDER BY started_at DESC`,
    [ACTIVE_WINDOW_SECONDS],
  );

  // Intentional cross-agent path enumeration for SAME-MACHINE studio
  // coordination (owner directive GAP-459). Paths only, no content. Trust
  // boundary remains the 0600 socket + Pro license. Do NOT expand this to
  // fleet/Neon without a separate security design.
  // Note: filter expiry in SQL; if a driver returns string timestamps that
  // compare poorly against NOW(), fall back to returning recent rows and
  // filter in JS below.
  const reservationsResult = await db.query<Record<string, unknown>>(
    `SELECT agent_id, file_path, reserved_at, expires_at, reason
       FROM file_reservations
      WHERE expires_at > NOW()
      ORDER BY reserved_at DESC
      LIMIT 200`,
  );

  // tasks: description is the free-text title line; status is open|claimed|...
  // No updated_at column on the daemon schema.
  const tasksResult = await db.query<Record<string, unknown>>(
    `SELECT id, description, status, owner, claimed_at, created_at
       FROM tasks
      WHERE status IN ('open', 'claimed', 'in_progress')
      ORDER BY created_at DESC
      LIMIT 100`,
  );

  // Shared findings/claims published via events.log with peer.* types
  // (contract: peer.finding, peer.claim, peer.intent). Global events table
  // is already cross-agent readable (events.query).
  const findingsResult = await db.query<Record<string, unknown>>(
    `SELECT agent_id, event_type, payload, created_at
       FROM events
      WHERE event_type LIKE 'peer.%'
      ORDER BY created_at DESC
      LIMIT $1`,
    [eventLimit],
  );

  const sessions = sessionsResult.rows.map((r) => {
    const id = String(r.id);
    const env = typeof r.env === 'string' ? r.env : '';
    const colon = env.indexOf(':');
    const agentName = colon >= 0 ? env.slice(colon + 1) : env || id;
    return {
      id,
      agentId: id,
      agentName,
      env,
      task: r.task,
      files: r.files,
      activityState: r.activity_state,
      pid: r.pid,
      startedAt: r.started_at,
      updatedAt: r.updated_at,
      staleSeconds: r.staleSeconds,
      active: r.active,
      isSelf: selfAgentId != null && id === selfAgentId,
    };
  });

  const peers = includeSelf ? sessions : sessions.filter((s) => !s.isSelf);

  const reservations = reservationsResult.rows
    .map((r) => ({
      agentId: (r.agent_id ?? r.agentId) as string,
      path: String(r.file_path ?? r.filePath ?? r.path ?? ''),
      reservedAt: r.reserved_at ?? r.reservedAt,
      expiresAt: r.expires_at ?? r.expiresAt,
      reason: r.reason,
    }))
    .filter((r) => r.path.length > 0)
    .filter((r) => includeSelf || !selfAgentId || String(r.agentId) !== selfAgentId);

  const tasks = tasksResult.rows.map((r) => ({
    id: r.id,
    title: r.description,
    status: r.status,
    owner: r.owner,
    claimedAt: r.claimed_at,
    createdAt: r.created_at,
  }));

  const findings = findingsResult.rows.map((r) => ({
    agentId: r.agent_id,
    eventType: r.event_type,
    payload: r.payload,
    createdAt: r.created_at,
  }));

  return {
    available: true,
    scope: 'local',
    selfAgentId,
    generatedAt: new Date().toISOString(),
    activeWindowSeconds: ACTIVE_WINDOW_SECONDS,
    peers,
    sessions,
    reservations,
    tasks,
    findings,
    // Adapter contract: when the daemon is DOWN, callers invent
    // { available: false, reason: 'daemon-unavailable' } client-side.
    degradation: {
      mode: 'advisory',
      rule: 'never-block',
      note: 'A claim is a signal, not a mutex (ADR 2026-07-28).',
    },
  };
});

// -- Health -----------------------------------------------------------------

function licenseHealthSummary(): {
  tier: LicenseTier;
  valid: boolean;
  present: boolean;
  source: 'env' | 'file' | 'none';
  status: string;
  expiresAt: number | null;
  secondsRemaining: number | null;
  goalRpcMinTier: 'pro';
  goalRpcReady: boolean;
  reason?: string;
} {
  // Never include key material — agents/Studio diagnose FREE vs Pro+ only.
  try {
    const ev = evaluateLicense();
    return {
      tier: ev.tier,
      valid: ev.valid,
      present: ev.present,
      source: ev.source,
      status: ev.status,
      expiresAt: ev.expiresAt,
      secondsRemaining: ev.secondsRemaining,
      goalRpcMinTier: 'pro',
      goalRpcReady: ev.valid && tierRank(ev.tier) >= tierRank('pro'),
      ...(ev.reason ? { reason: ev.reason } : {}),
    };
  } catch (err) {
    const reason =
      err instanceof LicenseConfigError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'license evaluation failed';
    return {
      tier: 'free',
      valid: false,
      present: true,
      source: 'none',
      status: 'invalid',
      expiresAt: null,
      secondsRemaining: null,
      goalRpcMinTier: 'pro',
      goalRpcReady: false,
      reason,
    };
  }
}

registerHandler('harness.health', async (_params, db) => {
  const sessions = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM agent_sessions WHERE ended_at IS NULL`,
  );
  const tasks = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM tasks WHERE status = 'open'`,
  );
  // D1 interim anchor-consistency assertion: every client-owned identity row
  // must have its (agent_id, fingerprint) pair in the loaded trust anchor.
  // Mismatches indicate anchor mis-provisioning (the residual D1 risk). The
  // check is best-effort — if the anchor is unavailable we skip it rather
  // than mark the daemon unhealthy.
  const anchorInconsistencies: string[] = [];
  try {
    const cfg = getDaemonConfig();
    const trusted = await loadTrustedClientEntries(
      cfg.trustedClientFingerprintPath,
      cfg.trustedAnchorRequireRootOwned,
    );
    const clientIds = await db.query<{ agent_id: string; fingerprint: string }>(
      `SELECT agent_id, fingerprint FROM agent_identity WHERE key_origin = 'client'`,
    );
    for (const row of clientIds.rows) {
      if (!trusted.has(`${row.agent_id}:${row.fingerprint}`)) {
        anchorInconsistencies.push(row.agent_id);
        log.warn('anchor-consistency: identity not in trust anchor', {
          agentId: row.agent_id,
          fingerprint: row.fingerprint,
        });
      }
    }
  } catch {
    /* anchor unavailable — skip; don't fail health check */
  }

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
    // D1 interim: list of client-owned agent_ids whose fingerprint is absent
    // from the trust anchor. Should be empty on a correctly provisioned
    // install; non-empty is a loud warning, not a daemon failure.
    anchorInconsistencies,
    // License summary (no secrets): goal.* and other Pro-floor RPCs need
    // valid Pro+ (enterprise daily-driver JWT satisfies this).
    license: licenseHealthSummary(),
  };
});

/**
 * GAP-154 Phase 5 — list daemon peers from Neon registry.
 * Empty when POSTGRES_URL unset (no fleet visibility, not "no peers exist").
 */
registerHandler('daemon.peers', async (params) => {
  const staleAfterSeconds = Math.max(30, Math.floor(num(params.staleAfterSeconds, 300)));
  const peers = await listDaemonPeers({ staleAfterSeconds });
  const selfId = getSelfDaemonId();
  return {
    neonSyncActive: isNeonSyncActive(),
    selfId,
    peers: peers.map((p) => ({
      ...p,
      isSelf: selfId !== null && p.id === selfId,
    })),
  };
});

registerHandler('harness.prune', async (params, db, ctx) => {
  // Allow ops to run a prune pass on demand. Defaults match DAEMON_DEFAULTS so
  // callers can invoke with no params.
  //
  // Signature-REQUIRED (GAP-312). This RPC reaches notifyAgentEnded for every
  // matched session, so it must not be drivable by an unsigned socket peer.
  // The dispatch gate already rejects unsigned callers before we get here;
  // this is the defense-in-depth backstop, mirroring spawn.ts requireAgent.
  if (ctx.boundVia !== 'signature' || !ctx.agentId) {
    throw new Error(
      'harness.prune requires a signed request (verified Ed25519 signature); unsigned or param-bound caller rejected',
    );
  }
  // The schema floors both thresholds at 1 day. Re-floor here so a schema
  // regression cannot hand runPrune a fleet-wide selector.
  const staleDays = Math.max(1, num(params.staleDays, DAEMON_DEFAULTS.staleSessionDays));
  const hardDeleteDays = Math.max(1, num(params.hardDeleteDays, DAEMON_DEFAULTS.hardDeleteDays));
  // Optional GAP-459 heartbeat arm. Omitted/0 = start-age only (backward compatible).
  // Positive values re-floored at MIN_HEARTBEAT_STALE_SECONDS inside runPrune.
  const heartbeatRaw = num(params.heartbeatStaleSeconds, 0);
  const heartbeatStaleSeconds =
    heartbeatRaw > 0 ? Math.max(MIN_HEARTBEAT_STALE_SECONDS, heartbeatRaw) : 0;
  const result = await runPrune(db, staleDays, hardDeleteDays, heartbeatStaleSeconds);
  return {
    aged: result.aged,
    deleted: result.deleted,
    runAt: pruneState.lastRunAt?.toISOString() ?? null,
    staleDays,
    hardDeleteDays,
    heartbeatStaleSeconds: result.heartbeatStaleSeconds,
  };
});

// -- Permission (GAP-294) ----------------------------------------------------

registerHandler('permission.pending', async (params, db, ctx) => {
  // Read surface: list pending approvals. Optional agentId filter.
  // Operator tools typically list all; agents may filter to self.
  const filter =
    strOrNull(params.agentId) ?? (ctx.agentId && params.scope === 'self' ? ctx.agentId : null);
  const approvals = await listPendingApprovals(db, filter);
  return { approvals };
});

registerHandler('permission.decide', async (params, db, ctx) => {
  // Signature-required (MUTATING). Self-approval rejected in decideApproval.
  const decider = await requireVerifiedAgent(ctx, db, params);
  const approvalId = str(params.approvalId);
  const verdictRaw = str(params.verdict).toLowerCase();
  if (verdictRaw !== 'approved' && verdictRaw !== 'denied') {
    throw new Error("permission.decide: verdict must be 'approved' or 'denied'");
  }
  return decideApproval(db, approvalId, verdictRaw, decider);
});

registerHandler('permission.setMode', async (params, db, ctx) => {
  // Signature-required (MUTATING). Operator sets another session's override.
  const operator = await requireVerifiedAgent(ctx, db, params);
  const target = str(params.agentId);
  // null / "" / "default" clears the override (falls back to daemon default).
  const rawMode = params.mode;
  let mode: ReturnType<typeof parseSessionPermissionMode> = null;
  if (rawMode !== null && rawMode !== undefined && rawMode !== '' && rawMode !== 'default') {
    mode = parseSessionPermissionMode(rawMode);
    if (mode === null) {
      throw new Error(
        "permission.setMode: mode must be 'manual' | 'auto' | 'agent-scoped' | 'shadow' | null",
      );
    }
  }
  const result = await setSessionPermissionMode(db, target, mode, operator);
  return {
    ...result,
    daemonDefault: resolvePermissionMode(),
  };
});

registerHandler('permission.listGrants', async (params, db) => {
  // Read surface: list agent-scope grants (GAP-294 §9). Optional grantee filter.
  const grantee = strOrNull(params.granteeAgentId) ?? strOrNull(params.agentId) ?? null;
  const includeInactive = params.includeInactive === true;
  const grants = await listGrants(db, grantee, includeInactive);
  return { grants };
});

registerHandler('permission.grant', async (params, db, ctx) => {
  // Signature-required (MUTATING). Operator issues a scope grant to another agent.
  const operator = await requireVerifiedAgent(ctx, db, params);
  const granteeAgentId = str(params.granteeAgentId ?? params.agentId);
  const classes = asStringArray(params.classes);
  const methods = asStringArray(params.methods);
  const rootScope = strOrNull(params.rootScope);
  const expiresAt = strOrNull(params.expiresAt);
  let maxUses: number | null = null;
  if (params.maxUses !== null && params.maxUses !== undefined && params.maxUses !== '') {
    maxUses = num(params.maxUses);
  }
  const grant = await issueGrant(db, {
    granteeAgentId,
    classes: classes.length > 0 ? classes : undefined,
    methods: methods.length > 0 ? methods : undefined,
    rootScope,
    expiresAt,
    maxUses,
    issuedBy: operator,
  });
  return { grant };
});

registerHandler('permission.revokeGrant', async (params, db, ctx) => {
  // Signature-required (MUTATING). Operator revokes an active grant.
  const operator = await requireVerifiedAgent(ctx, db, params);
  const grantId = str(params.grantId);
  return revokeGrant(db, grantId, operator);
});

// -- Session fidelity snapshots (GAP-342) ------------------------------------
// Five-section record keyed by daemon session id. get is id-match only
// (never "most recent by mtime"). write upserts; prune removes older than N days.

registerHandler('session.snapshot.write', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
  const sessionId = str(params.sessionId);
  const sections = normalizeFidelitySections(params.sections);
  const mechanical =
    params.mechanical && typeof params.mechanical === 'object' && !Array.isArray(params.mechanical)
      ? (params.mechanical as Record<string, unknown>)
      : {};

  await db.query(
    `INSERT INTO session_fidelity_snapshots (session_id, agent_id, sections, mechanical, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, NOW(), NOW())
     ON CONFLICT (session_id) DO UPDATE SET
       agent_id = EXCLUDED.agent_id,
       sections = EXCLUDED.sections,
       mechanical = EXCLUDED.mechanical,
       updated_at = NOW()`,
    [sessionId, agentId, JSON.stringify(sections), JSON.stringify(mechanical)],
  );

  // Best-effort retention sweep (GAP-317 7-day archive parity)
  try {
    const cutoff = retentionCutoffIso(new Date(), SNAPSHOT_RETENTION_DAYS);
    await db.query(`DELETE FROM session_fidelity_snapshots WHERE updated_at < $1::timestamptz`, [
      cutoff,
    ]);
  } catch {
    // prune failure must not fail the write
  }

  return { sessionId, written: true, updatedAt: new Date().toISOString() };
});

registerHandler('session.snapshot.get', async (params, db, ctx) => {
  await requireVerifiedAgent(ctx, db, params);
  const sessionId = str(params.sessionId);
  const result = await db.query<Record<string, unknown>>(
    `SELECT session_id, agent_id, sections, mechanical, created_at, updated_at
     FROM session_fidelity_snapshots
     WHERE session_id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) {
    return { snapshot: null };
  }
  return {
    snapshot: {
      sessionId: row.session_id,
      agentId: row.agent_id,
      sections: row.sections,
      mechanical: row.mechanical,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
});

registerHandler('session.snapshot.prune', async (params, db, ctx) => {
  await requireVerifiedAgent(ctx, db, params);
  const maxAgeDays = num(params.maxAgeDays, SNAPSHOT_RETENTION_DAYS);
  const cutoff = retentionCutoffIso(new Date(), maxAgeDays);
  const result = await db.query(
    `DELETE FROM session_fidelity_snapshots WHERE updated_at < $1::timestamptz RETURNING session_id`,
    [cutoff],
  );
  return { pruned: true, maxAgeDays, cutoff, deleted: result.rows.length };
});

// -- Memory -----------------------------------------------------------------

registerHandler('memory.store', async (params, db, ctx) => {
  const agentId = await requireVerifiedAgent(ctx, db, params);
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
  const agentId = await requireVerifiedAgent(ctx, db, params);
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
): Promise<{ close: () => Promise<void>; _db: PGlite; _httpGateway: HttpGateway | null }> {
  const cfg = { ...DAEMON_DEFAULTS, ...config };
  // Publish the effective config so handlers in other modules (filegit.ts)
  // can read limits like maxInlineReadBytes without a cfg parameter.
  _daemonConfig = cfg;

  // Reset shutdown signal + closing gate for this daemon lifecycle.
  // _shutdownController is aborted in close(); _closing is set to true
  // at the start of close() and reset to false at the end.
  _shutdownController = new AbortController();
  _closing = false;

  // Initialize license guard (logs banner)
  initLicenseGuard();

  // Initialize the native security tool-guard. Fails CLOSED, like
  // initLicenseGuard: a daemon that cannot load its safety patterns refuses to
  // start. Runs before the socket binds, so the throw aborts startup cleanly.
  initToolGuard();

  // Initialize Neon sync (GAP-154 Phase 2). No-op when POSTGRES_URL is
  // unset — daemon runs single-machine fine; sync is purely additive.
  initNeonSync();

  // Register the built-in session-lifecycle advisory checks. Ships with an
  // empty rule set (a no-op) so nothing project-specific is baked in; a
  // consuming project supplies canonical-path rules to activate them.
  initSessionChecks();

  // Ensure data directory exists
  await mkdir(cfg.dataDir, { recursive: true });
  // Create the socket's parent dir with an explicit owner-only mode. Without
  // `mode`, the dir inherits the umask; the socket itself is bound 0600 (see
  // listen() below), but a world-traversable parent dir is an unnecessary
  // weakening of the filesystem boundary that gates the Unix socket.
  await mkdir(dirname(cfg.socketPath), { recursive: true, mode: 0o700 });

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

  // Run startup hooks (e.g. restoreProjectRoots in filegit.ts). Runs after
  // migration so all tables exist before hooks query them.
  await notifyDaemonStarted(db);

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
      keyOrigin: null,
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

        // Every gate (license, param validation, signature, identity,
        // permission, shutdown) plus handler execution lives in dispatchRpc
        // so the socket and HTTP gateway transports share one authorization
        // path (GAP-421 daemon-ownership ADR, wire path §1).
        const response = await dispatchRpc(req, db, ctx);
        socket.write(`${JSON.stringify(response)}\n`);
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

      // Optional HTTP gateway (GAP-421 daemon-ownership ADR wire path §3).
      // Default OFF: httpPort defaults to 0, and this daemon only ever
      // constructs a listener when the operator sets it explicitly. Every
      // /rpc and /api/* request runs through the exact same dispatchRpc as
      // the Unix socket (see http-gateway.ts).
      let httpGateway: HttpGateway | null = null;
      if (cfg.httpPort) {
        httpGateway = new HttpGateway({
          port: cfg.httpPort,
          host: cfg.httpHost,
          staticDir: cfg.httpStaticDir,
          db,
          secretPath: join(cfg.dataDir, 'gateway-pairing-secret'),
        });
        try {
          await httpGateway.initAuth();
          await httpGateway.start();
          log.info('http gateway listening', {
            host: cfg.httpHost,
            port: httpGateway.getPort(),
          });
        } catch (err) {
          reject(err);
          return;
        }
      }

      // GAP-154 Phase 5: register this daemon in Neon peer registry (no-op without POSTGRES_URL).
      const host = osHostname();
      const dataHash = createHash('sha256').update(cfg.dataDir).digest('hex').slice(0, 12);
      const daemonId = process.env.REVDEV_DAEMON_ID?.trim() || `daemon:${host}:${dataHash}`;
      const gatewayPort = httpGateway?.getPort() ?? null;
      const httpGatewayUrl =
        gatewayPort && gatewayPort > 0
          ? `http://${cfg.httpHost === '0.0.0.0' ? host : cfg.httpHost}:${gatewayPort}`
          : null;
      await registerDaemonPeer({
        daemonId,
        env: process.env.REVDEV_DAEMON_ENV?.trim() || host,
        hostname: host,
        httpGatewayUrl,
        socketHint: cfg.socketPath,
        pid: process.pid,
      });
      // Heartbeat so peers stay "fresh" while this process lives.
      const peerHeartbeat = setInterval(() => {
        void heartbeatDaemonPeer(daemonId);
      }, 60_000);
      peerHeartbeat.unref();

      resolve({
        _db: db,
        _httpGateway: httpGateway,
        close: async () => {
          clearInterval(peerHeartbeat);
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
          // GAP-323 (+ future): release FS watchers / long-lived resources.
          await notifyDaemonStopping();
          if (httpGateway) await httpGateway.stop();
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
