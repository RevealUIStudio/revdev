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
 */

import { type NeonQueryFunction, neon } from '@neondatabase/serverless';
import { createLogger } from '@revealui/utils/logger';

const log = createLogger({ service: 'revdev-daemon-neon' });

let client: NeonQueryFunction<false, false> | null = null;

/**
 * Initialize the Neon client from `POSTGRES_URL` env var (or override).
 * Idempotent. When the URL is empty/unset, sync is disabled and all
 * helpers below are silent no-ops.
 */
export function initNeonSync(databaseUrl?: string | undefined): void {
  const url = databaseUrl ?? process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? '';
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

/** Mirror a daemon `mail.send` row into coordination_mail. */
export async function syncMailSend(params: {
  fromAgent: string;
  toAgent: string;
  subject: string;
  body: string;
}): Promise<void> {
  if (!client) return;
  try {
    const c = client;
    await c`
      INSERT INTO coordination_mail (from_agent, to_agent, subject, body)
      VALUES (${params.fromAgent}, ${params.toAgent}, ${params.subject}, ${params.body})
    `;
  } catch (err) {
    log.warn('syncMailSend failed', {
      fromAgent: params.fromAgent,
      toAgent: params.toAgent,
      error: String(err),
    });
  }
}

/**
 * Mirror a daemon `mail.broadcast` (one row per recipient). The daemon's
 * INSERT loop in mail.broadcast fans out — this helper takes the same
 * recipient list to keep the per-row write parity with PGlite.
 */
export async function syncMailBroadcast(params: {
  fromAgent: string;
  toAgents: string[];
  subject: string;
  body: string;
}): Promise<void> {
  if (!client) return;
  if (params.toAgents.length === 0) return;
  try {
    const c = client;
    for (const to of params.toAgents) {
      await c`
        INSERT INTO coordination_mail (from_agent, to_agent, subject, body)
        VALUES (${params.fromAgent}, ${to}, ${params.subject}, ${params.body})
      `;
    }
  } catch (err) {
    log.warn('syncMailBroadcast failed', {
      fromAgent: params.fromAgent,
      recipients: params.toAgents.length,
      error: String(err),
    });
  }
}

/**
 * Mirror a daemon `mail.markRead` to Neon. The daemon uses SERIAL ids
 * scoped to its local PGlite — those ids will not match Neon's SERIAL ids
 * (different sequences). We therefore mark by (toAgent, fromAgent,
 * subject, createdAt-window) heuristic rather than id. For Phase 3 we
 * just bulk-mark all unread mail FROM the fromAgent TO the markReader.
 *
 * NOTE: this is a best-effort approximation. If two agents send overlapping
 * "ping" subjects, marking one read on the daemon will mark BOTH on Neon.
 * Phase 3+ may add a stable cross-DB id (UUID) to avoid this; logged as a
 * known limitation here.
 */
export async function syncMailMarkRead(params: {
  reader: string;
  ids: number[]; // daemon-local PGlite ids
  // Best-effort: also pass the (subject + body) tuples to scope the Neon
  // UPDATE more precisely. If absent, falls back to "mark all unread to
  // this reader" which is over-broad.
  hints?: Array<{ subject: string; body: string }>;
}): Promise<void> {
  if (!client) return;
  if (params.ids.length === 0) return;
  try {
    const c = client;
    if (params.hints && params.hints.length > 0) {
      // Mark unread rows whose (subject, body) match any hint.
      for (const hint of params.hints) {
        await c`
          UPDATE coordination_mail
            SET read = TRUE
          WHERE to_agent = ${params.reader}
            AND read = FALSE
            AND subject = ${hint.subject}
            AND body = ${hint.body}
        `;
      }
    } else {
      // Over-broad fallback. Match the count being marked locally to
      // bound the impact: only mark the N oldest unread rows.
      const limit = params.ids.length;
      await c`
        UPDATE coordination_mail
          SET read = TRUE
        WHERE id IN (
          SELECT id FROM coordination_mail
          WHERE to_agent = ${params.reader} AND read = FALSE
          ORDER BY created_at ASC
          LIMIT ${limit}
        )
      `;
    }
  } catch (err) {
    log.warn('syncMailMarkRead failed', { reader: params.reader, error: String(err) });
  }
}

/**
 * Mirror a daemon `files.reserve` row(s) into coordination_file_claims.
 * Schema divergence: daemon has TTL + reason; Neon has only (file_path,
 * session_id, claimed_at) composite PK. We sync only the subset; TTL
 * expiry on the daemon side does NOT propagate to Neon (a future cleanup
 * pass needs to handle that). For Phase 3 this is a known limitation.
 */
export async function syncFilesReserve(params: {
  sessionId: string;
  paths: string[];
}): Promise<void> {
  if (!client) return;
  if (params.paths.length === 0) return;
  try {
    const c = client;
    for (const p of params.paths) {
      await c`
        INSERT INTO coordination_file_claims (file_path, session_id)
        VALUES (${p}, ${params.sessionId})
        ON CONFLICT (file_path, session_id) DO UPDATE
          SET claimed_at = NOW()
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

/** Reset module state. Test-only. */
export function _resetForTesting(): void {
  client = null;
}
