/**
 * Daemon → Neon coordination_* sync (GAP-154 Phase 2).
 *
 * The daemon owns local PGlite as the source of truth for in-process state.
 * When `POSTGRES_URL` is set, every session.register / session.update /
 * session.end ALSO writes to the Neon `coordination_*` tables, making the
 * session visible to other daemons (cross-machine fleet coordination) and
 * to the admin dashboard (live agent surface).
 *
 * Design decisions (locked in Phase 1, see GAP-154.yml):
 *   - Direct daemon → Neon writes (Option A). ElectricSQL is one-way
 *     (Neon → browser); not usable for the reverse direction.
 *   - PGlite stays as the local source of truth + offline cache.
 *   - Best-effort dual-write: Neon failures are LOGGED, not raised. The
 *     RPC succeeds based on the PGlite write. A future Phase 6 adds
 *     offline replay via a `synced` flag; this Phase 2 ships without it.
 *   - License auth: the daemon's existing license guard already gates
 *     coordination RPCs. Neon writes inherit the same gate; no separate
 *     service-account model.
 *   - Schema mapping is 1:1 in this module (no schema migrations on
 *     either side). Daemon's `agent_sessions.id` → Neon's
 *     `coordination_sessions.id`; `agentId` doubles as
 *     `coordination_agents.id` (matches the daemon's logical-identity
 *     model where agentId IS the session id for stable registrations).
 *
 * When `POSTGRES_URL` is unset, all helpers are no-ops. The daemon runs
 * fine single-machine; sync is purely additive.
 *
 * Intentional non-sync (GAP-174, closed 2026-08-05 — not an audit miss):
 *   - `memory.*` (agent_memory in PGlite) and `merge.*` (merge_requests in
 *     PGlite) have NO Neon `coordination_*` counterparts. The Neon schema
 *     (`@revealui/db` coordination.ts) covers agents, sessions, file claims,
 *     events, work items, mail, and queue items only. Dual-write for
 *     memory/merge would need new tables + migrations; that is multi-machine
 *     scope and rides GAP-154 Phase 5 (cross-machine discovery/gateway) if
 *     and when fleet-wide agent memory or merge-request lifecycle must
 *     reconcile across daemons. Until then they stay local-only by design.
 */

import { readFileSync } from 'node:fs';
import { type NeonQueryFunction, neon } from '@neondatabase/serverless';
import { createLogger } from '@revealui/utils/logger';

const log = createLogger({ service: 'revdev-daemon-neon' });

let client: NeonQueryFunction<false, false> | null = null;

/**
 * Resolve Neon URL without putting secrets on argv.
 * Priority: explicit arg → POSTGRES_URL → DATABASE_URL → POSTGRES_URL_FILE
 * (file path is stream-safe for systemd PrivateTmp materialization).
 */
export function resolvePostgresUrl(databaseUrl?: string | undefined): string {
  if (databaseUrl?.trim()) return databaseUrl.trim();
  const inline = process.env.POSTGRES_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (inline) return inline;
  const filePath = process.env.POSTGRES_URL_FILE?.trim();
  if (!filePath) return '';
  try {
    const text = readFileSync(filePath, 'utf8').trim();
    return text;
  } catch (err) {
    log.warn('POSTGRES_URL_FILE unreadable', {
      path: filePath,
      error: String(err),
    });
    return '';
  }
}

/**
 * Initialize the Neon client from `POSTGRES_URL` / `DATABASE_URL` /
 * `POSTGRES_URL_FILE` (or override). Idempotent. When empty/unset, sync is
 * disabled and all helpers below are silent no-ops.
 */
export function initNeonSync(databaseUrl?: string | undefined): void {
  const url = resolvePostgresUrl(databaseUrl);
  if (url) {
    client = neon(url);
    log.info('neon sync enabled', { hasUrl: true });
  } else {
    client = null;
    log.info('neon sync disabled (no POSTGRES_URL)', { hasUrl: false });
  }
}

/** Test seam: inject a fake client for unit tests. */
export function setNeonClientForTesting(fake: NeonQueryFunction<false, false> | null): void {
  client = fake;
}

/** Returns true if Neon sync is currently active. Useful for diagnostics. */
export function isNeonSyncActive(): boolean {
  return client !== null;
}

interface RegisterParams {
  agentId: string;
  agentName: string;
  env: string;
  task: string;
  pid: number | null;
}

/**
 * Mirror a daemon `session.register` to Neon: upsert coordination_agents +
 * upsert coordination_sessions. Idempotent — re-registering the same
 * agentId re-opens the session row (mirrors the daemon's PGlite UPSERT).
 */
export async function syncSessionRegister(params: RegisterParams): Promise<void> {
  if (!client) return;
  try {
    const c = client;
    // Agent: upsert with bumped last_seen + total_sessions counter.
    await c`
      INSERT INTO coordination_agents (id, env, last_seen, total_sessions, metadata)
      VALUES (
        ${params.agentId},
        ${params.env},
        NOW(),
        1,
        ${JSON.stringify({ name: params.agentName })}::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        env = EXCLUDED.env,
        last_seen = NOW(),
        total_sessions = coordination_agents.total_sessions + 1
    `;
    // Session: upsert. agentId doubles as session id (logical identity).
    // Re-registering re-opens an ended session (clears ended_at, status='active').
    await c`
      INSERT INTO coordination_sessions (id, agent_id, task, status, pid, started_at)
      VALUES (
        ${params.agentId},
        ${params.agentId},
        ${params.task},
        'active',
        ${params.pid},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        task = EXCLUDED.task,
        status = 'active',
        pid = EXCLUDED.pid,
        ended_at = NULL
    `;
  } catch (err) {
    log.warn('syncSessionRegister failed', { agentId: params.agentId, error: String(err) });
  }
}

/**
 * Mirror a daemon `session.update` to Neon. Only mutates the columns the
 * caller passed; Neon-side `metadata` is left alone (the daemon doesn't
 * know what tools/metadata the admin surface wants there).
 */
export async function syncSessionUpdate(params: {
  sessionId: string;
  task?: string;
}): Promise<void> {
  if (!client) return;
  if (params.task === undefined) return; // Nothing to update.
  try {
    const c = client;
    await c`
      UPDATE coordination_sessions
        SET task = ${params.task}
      WHERE id = ${params.sessionId}
    `;
  } catch (err) {
    log.warn('syncSessionUpdate failed', { sessionId: params.sessionId, error: String(err) });
  }
}

/**
 * Mirror a daemon `session.end` to Neon. Sets ended_at + status='ended' and
 * folds the daemon's `exit_summary` into the Neon-side metadata JSONB so it
 * survives without requiring a schema column.
 */
export async function syncSessionEnd(params: {
  sessionId: string;
  summary?: string | null;
}): Promise<void> {
  if (!client) return;
  try {
    const c = client;
    const summary = params.summary ?? null;
    await c`
      UPDATE coordination_sessions
        SET ended_at = NOW(),
            status = 'ended',
            metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
              exit_summary: summary,
            })}::jsonb
      WHERE id = ${params.sessionId}
    `;
  } catch (err) {
    log.warn('syncSessionEnd failed', { sessionId: params.sessionId, error: String(err) });
  }
}

interface FleetSessionRow {
  id: string;
  agent_id: string;
  task: string;
  status: string;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
}

/**
 * List active sessions across the fleet (any daemon writing to the same
 * Neon db). Returns [] when Neon sync is disabled — callers should treat
 * empty as "no fleet visibility" not "no fleet sessions exist."
 */
export async function listFleetSessions(): Promise<FleetSessionRow[]> {
  if (!client) return [];
  try {
    const c = client;
    const rows = await c`
      SELECT id, agent_id, task, status, pid, started_at, ended_at
      FROM coordination_sessions
      WHERE ended_at IS NULL
      ORDER BY started_at DESC
    `;
    return rows as FleetSessionRow[];
  } catch (err) {
    log.warn('listFleetSessions failed', { error: String(err) });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — mail / files / tasks / events sync helpers (GAP-154 §work Phase 3)
//
// Same best-effort pattern as the Phase 2 session helpers: fail soft, log,
// don't break the RPC. Each helper maps the daemon's PGlite schema to the
// Neon coordination_* schema 1:1, handling the divergences inline (status
// enum translation, missing columns deferred to metadata JSONB, etc.).
// ---------------------------------------------------------------------------

/** Mirror a daemon `mail.send` row into coordination_mail (GAP-176 UUID id). */
export async function syncMailSend(params: {
  id: string;
  fromAgent: string;
  toAgent: string;
  subject: string;
  body: string;
}): Promise<void> {
  if (!client) return;
  try {
    const c = client;
    await c`
      INSERT INTO coordination_mail (id, from_agent, to_agent, subject, body)
      VALUES (${params.id}::uuid, ${params.fromAgent}, ${params.toAgent}, ${params.subject}, ${params.body})
    `;
  } catch (err) {
    log.warn('syncMailSend failed', {
      id: params.id,
      fromAgent: params.fromAgent,
      toAgent: params.toAgent,
      error: String(err),
    });
  }
}

/**
 * Mirror a daemon `mail.broadcast` (one row per recipient). Each row carries
 * its own UUID so markRead can target a single message (GAP-176).
 */
export async function syncMailBroadcast(params: {
  fromAgent: string;
  rows: Array<{ id: string; toAgent: string; subject: string; body: string }>;
}): Promise<void> {
  if (!client) return;
  if (params.rows.length === 0) return;
  try {
    const c = client;
    for (const row of params.rows) {
      await c`
        INSERT INTO coordination_mail (id, from_agent, to_agent, subject, body)
        VALUES (${row.id}::uuid, ${params.fromAgent}, ${row.toAgent}, ${row.subject}, ${row.body})
      `;
    }
  } catch (err) {
    log.warn('syncMailBroadcast failed', {
      fromAgent: params.fromAgent,
      recipients: params.rows.length,
      error: String(err),
    });
  }
}

/**
 * Mirror a daemon `mail.markRead` to Neon by shared UUID primary key (GAP-176).
 * No subject/body heuristic — the same id exists on both PGlite and Neon.
 */
export async function syncMailMarkRead(params: { reader: string; ids: string[] }): Promise<void> {
  if (!client) return;
  if (params.ids.length === 0) return;
  try {
    const c = client;
    await c`
      UPDATE coordination_mail
        SET read = TRUE
      WHERE to_agent = ${params.reader}
        AND id = ANY(${params.ids}::uuid[])
    `;
  } catch (err) {
    log.warn('syncMailMarkRead failed', {
      reader: params.reader,
      idCount: params.ids.length,
      error: String(err),
    });
  }
}

/**
 * Mirror a daemon `files.reserve` row(s) into coordination_file_claims.
 * GAP-175: write `expires_at` (ISO / Date) so Neon can drop expired claims
 * via `sweepExpiredFileClaims` (piggybacked on the daemon prune timer).
 * `reason` stays PGlite-only (no Neon column).
 */
export async function syncFilesReserve(params: {
  sessionId: string;
  paths: string[];
  /** Absolute expiry for this reservation batch (daemon TTL). */
  expiresAt: Date | string;
}): Promise<void> {
  if (!client) return;
  if (params.paths.length === 0) return;
  const expiresAt =
    params.expiresAt instanceof Date ? params.expiresAt.toISOString() : params.expiresAt;
  try {
    const c = client;
    for (const p of params.paths) {
      await c`
        INSERT INTO coordination_file_claims (file_path, session_id, expires_at)
        VALUES (${p}, ${params.sessionId}, ${expiresAt}::timestamptz)
        ON CONFLICT (file_path, session_id) DO UPDATE
          SET claimed_at = NOW(),
              expires_at = EXCLUDED.expires_at
      `;
    }
  } catch (err) {
    log.warn('syncFilesReserve failed', {
      sessionId: params.sessionId,
      pathCount: params.paths.length,
      error: String(err),
    });
  }
}

/**
 * Delete Neon file claims past their TTL (GAP-175). Best-effort; no-op without
 * POSTGRES_URL. Safe to call from the periodic prune timer.
 */
export async function sweepExpiredFileClaims(): Promise<{ deleted: number }> {
  if (!client) return { deleted: 0 };
  try {
    const c = client;
    // Neon serverless returns row metadata inconsistently; count via RETURNING.
    const rows = await c`
      DELETE FROM coordination_file_claims
      WHERE expires_at IS NOT NULL
        AND expires_at < NOW()
      RETURNING file_path
    `;
    const deleted = Array.isArray(rows) ? rows.length : 0;
    if (deleted > 0) {
      log.info('sweepExpiredFileClaims', { deleted });
    }
    return { deleted };
  } catch (err) {
    log.warn('sweepExpiredFileClaims failed', { error: String(err) });
    return { deleted: 0 };
  }
}

/**
 * Mirror a daemon `files.release` to Neon. With no paths, releases all
 * claims for the session (matches daemon semantics).
 */
export async function syncFilesRelease(params: {
  sessionId: string;
  paths: string[];
}): Promise<void> {
  if (!client) return;
  try {
    const c = client;
    if (params.paths.length === 0) {
      await c`
        DELETE FROM coordination_file_claims
        WHERE session_id = ${params.sessionId}
      `;
    } else {
      await c`
        DELETE FROM coordination_file_claims
        WHERE session_id = ${params.sessionId}
          AND file_path = ANY(${params.paths}::text[])
      `;
    }
  } catch (err) {
    log.warn('syncFilesRelease failed', {
      sessionId: params.sessionId,
      pathCount: params.paths.length,
      error: String(err),
    });
  }
}

/** Mirror a daemon `tasks.create` row into coordination_work_items. */
export async function syncTaskCreate(params: {
  id: string;
  title: string;
  description: string;
  priority: number;
}): Promise<void> {
  if (!client) return;
  try {
    const c = client;
    await c`
      INSERT INTO coordination_work_items (id, title, description, status, priority)
      VALUES (
        ${params.id},
        ${params.title || params.id},
        ${params.description || null},
        'open',
        ${params.priority}
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        priority = EXCLUDED.priority,
        status = 'open',
        owner_agent = NULL,
        owner_session = NULL,
        completed_at = NULL,
        updated_at = NOW()
    `;
  } catch (err) {
    log.warn('syncTaskCreate failed', { taskId: params.id, error: String(err) });
  }
}

/** Mirror a daemon `tasks.claim` to Neon. */
export async function syncTaskClaim(params: { taskId: string; ownerAgent: string }): Promise<void> {
  if (!client) return;
  try {
    const c = client;
    await c`
      UPDATE coordination_work_items
        SET status = 'claimed',
            owner_agent = ${params.ownerAgent},
            updated_at = NOW()
      WHERE id = ${params.taskId}
        AND (status = 'open' OR owner_agent = ${params.ownerAgent})
    `;
  } catch (err) {
    log.warn('syncTaskClaim failed', { taskId: params.taskId, error: String(err) });
  }
}

/**
 * Mirror a daemon `tasks.complete` to Neon. Translates daemon status
 * 'completed' → Neon status 'done' (different enum values across schemas).
 * Folds the optional summary into the description for parity with the
 * daemon's `description = description || ' — ' || summary` pattern.
 */
export async function syncTaskComplete(params: {
  taskId: string;
  ownerAgent: string;
  summary: string | null;
}): Promise<void> {
  if (!client) return;
  try {
    const c = client;
    if (params.summary) {
      await c`
        UPDATE coordination_work_items
          SET status = 'done',
              completed_at = NOW(),
              description = COALESCE(description, '') || ' — ' || ${params.summary},
              updated_at = NOW()
        WHERE id = ${params.taskId}
          AND owner_agent = ${params.ownerAgent}
      `;
    } else {
      await c`
        UPDATE coordination_work_items
          SET status = 'done',
              completed_at = NOW(),
              updated_at = NOW()
        WHERE id = ${params.taskId}
          AND owner_agent = ${params.ownerAgent}
      `;
    }
  } catch (err) {
    log.warn('syncTaskComplete failed', { taskId: params.taskId, error: String(err) });
  }
}

/** Mirror a daemon `tasks.release` to Neon. */
export async function syncTaskRelease(params: {
  taskId: string;
  ownerAgent: string;
}): Promise<void> {
  if (!client) return;
  try {
    const c = client;
    await c`
      UPDATE coordination_work_items
        SET status = 'open',
            owner_agent = NULL,
            owner_session = NULL,
            updated_at = NOW()
      WHERE id = ${params.taskId}
        AND owner_agent = ${params.ownerAgent}
    `;
  } catch (err) {
    log.warn('syncTaskRelease failed', { taskId: params.taskId, error: String(err) });
  }
}

/**
 * Mirror a daemon `events.log` to coordination_events.
 * The daemon's `events` schema has no `session_id` or `level` columns;
 * Neon's coordination_events has both — `session_id` is left null (the
 * caller's session id is conveyed only via agent_id), and `level`
 * defaults to 'info' on the Neon side.
 */
export async function syncEventLog(params: {
  agentId: string;
  type: string;
  payload: unknown;
}): Promise<void> {
  if (!client) return;
  try {
    const c = client;
    await c`
      INSERT INTO coordination_events (agent_id, type, level, payload)
      VALUES (
        ${params.agentId},
        ${params.type},
        'info',
        ${JSON.stringify(params.payload ?? {})}::jsonb
      )
    `;
  } catch (err) {
    log.warn('syncEventLog failed', {
      agentId: params.agentId,
      type: params.type,
      error: String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Phase 5 — daemon peer registry (cross-machine discovery)
//
// Reuses coordination_agents with metadata.role = 'daemon' (no new table).
// Each daemon upserts itself at startup (+ optional heartbeat). Peers list
// returns daemons seen recently so fleet operators can discover HTTP
// gateways / hosts without a separate registry product.
// ---------------------------------------------------------------------------

export interface DaemonPeerRow {
  id: string;
  env: string;
  lastSeen: string;
  hostname: string | null;
  httpGatewayUrl: string | null;
  socketHint: string | null;
  pid: number | null;
  role: 'daemon';
}

let selfDaemonId: string | null = null;

/** Stable id for this daemon process (set by registerDaemonPeer). */
export function getSelfDaemonId(): string | null {
  return selfDaemonId;
}

/**
 * Upsert this daemon into the Neon fleet registry.
 * No-op when Neon sync is disabled.
 */
export async function registerDaemonPeer(params: {
  daemonId: string;
  env: string;
  hostname: string;
  httpGatewayUrl: string | null;
  socketHint: string | null;
  pid: number;
}): Promise<void> {
  selfDaemonId = params.daemonId;
  if (!client) return;
  try {
    const c = client;
    const metadata = {
      role: 'daemon',
      hostname: params.hostname,
      httpGatewayUrl: params.httpGatewayUrl,
      socketHint: params.socketHint,
      pid: params.pid,
      registeredAt: new Date().toISOString(),
    };
    await c`
      INSERT INTO coordination_agents (id, env, last_seen, total_sessions, metadata)
      VALUES (
        ${params.daemonId},
        ${params.env},
        NOW(),
        0,
        ${JSON.stringify(metadata)}::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        env = EXCLUDED.env,
        last_seen = NOW(),
        metadata = COALESCE(coordination_agents.metadata, '{}'::jsonb) || EXCLUDED.metadata
    `;
  } catch (err) {
    log.warn('registerDaemonPeer failed', {
      daemonId: params.daemonId,
      error: String(err),
    });
  }
}

/**
 * Touch last_seen for this daemon (periodic heartbeat).
 */
export async function heartbeatDaemonPeer(daemonId: string): Promise<void> {
  if (!client) return;
  try {
    const c = client;
    await c`
      UPDATE coordination_agents
        SET last_seen = NOW()
      WHERE id = ${daemonId}
        AND metadata->>'role' = 'daemon'
    `;
  } catch (err) {
    log.warn('heartbeatDaemonPeer failed', { daemonId, error: String(err) });
  }
}

/**
 * List recently-seen daemon peers from Neon.
 * Returns [] when Neon sync is disabled.
 */
export async function listDaemonPeers(opts?: {
  staleAfterSeconds?: number;
}): Promise<DaemonPeerRow[]> {
  if (!client) return [];
  const staleAfter = opts?.staleAfterSeconds ?? 300;
  try {
    const c = client;
    const rows = await c`
      SELECT id, env, last_seen, metadata
      FROM coordination_agents
      WHERE metadata->>'role' = 'daemon'
        AND last_seen > NOW() - make_interval(secs => ${staleAfter})
      ORDER BY last_seen DESC
    `;
    return (rows as Array<Record<string, unknown>>).map((r) => {
      const meta =
        r.metadata && typeof r.metadata === 'object' ? (r.metadata as Record<string, unknown>) : {};
      return {
        id: String(r.id ?? ''),
        env: String(r.env ?? ''),
        lastSeen: String(r.last_seen ?? ''),
        hostname: meta.hostname == null ? null : String(meta.hostname),
        httpGatewayUrl: meta.httpGatewayUrl == null ? null : String(meta.httpGatewayUrl),
        socketHint: meta.socketHint == null ? null : String(meta.socketHint),
        pid: typeof meta.pid === 'number' ? meta.pid : null,
        role: 'daemon' as const,
      };
    });
  } catch (err) {
    log.warn('listDaemonPeers failed', { error: String(err) });
    return [];
  }
}

/** Reset module state. Test-only. */
export function _resetForTesting(): void {
  client = null;
  selfDaemonId = null;
}
