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

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { createLogger } from '@revealui/utils/logger';

const log = createLogger({ service: 'revdev-daemon-neon' });

let client: NeonQueryFunction<false, false> | null = null;
let configured = false;

/**
 * Initialize the Neon client from `POSTGRES_URL` env var (or override).
 * Idempotent. When the URL is empty/unset, sync is disabled and all
 * helpers below are silent no-ops.
 */
export function initNeonSync(databaseUrl?: string | undefined): void {
  const url = databaseUrl ?? process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? '';
  configured = true;
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
  configured = true;
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

/** Reset module state. Test-only. */
export function _resetForTesting(): void {
  client = null;
  configured = false;
}
