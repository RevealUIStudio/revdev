/**
 * Migration 0005 — session activity-state (GAP-257).
 *
 * Adds a coarse `activity_state` to `agent_sessions` so coordination
 * consumers can distinguish a session that is actively working from one
 * that is blocked on an unanswered permission prompt (which is otherwise
 * byte-identical in shape to a live row). Default 'active' so every
 * pre-existing row keeps its current meaning.
 *
 * `blocked_since` is `TIMESTAMP` (not the spec's `TIMESTAMPTZ`) to match
 * the existing `agent_sessions` columns (started_at/updated_at/ended_at
 * are all `TIMESTAMP` — schema.ts) and the NOW()-relative comparisons the
 * prune + active-window logic already use.
 */

import type { Migration } from '../storage/migrate.js';

const SQL = `
  ALTER TABLE agent_sessions
    ADD COLUMN IF NOT EXISTS activity_state TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE agent_sessions
    ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
  ALTER TABLE agent_sessions
    ADD COLUMN IF NOT EXISTS blocked_since  TIMESTAMP;

  CREATE INDEX IF NOT EXISTS idx_agent_sessions_activity
    ON agent_sessions (activity_state);
`;

export const MIGRATION_0005: Migration = {
  version: 5,
  name: 'session-activity-state',
  sql: SQL,
};
