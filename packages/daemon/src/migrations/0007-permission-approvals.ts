/**
 * Migration 0007 — permission modes Phase 1 (GAP-294).
 *
 * - pending_approvals queue for reject-with-receipt manual mode
 * - optional per-session permission_mode override on agent_sessions
 */

import type { Migration } from '../storage/migrate.js';

const SQL = `
  CREATE TABLE IF NOT EXISTS pending_approvals (
    id            TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    method        TEXT NOT NULL,
    params_hash   TEXT NOT NULL,
    summary       TEXT NOT NULL DEFAULT '',
    requested_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMP NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    decided_by    TEXT,
    decided_at    TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_pending_approvals_agent_status
    ON pending_approvals (agent_id, status, expires_at);

  CREATE INDEX IF NOT EXISTS idx_pending_approvals_consume
    ON pending_approvals (agent_id, method, params_hash, status);

  ALTER TABLE agent_sessions
    ADD COLUMN IF NOT EXISTS permission_mode TEXT;
`;

export const MIGRATION_0007: Migration = {
  version: 7,
  name: 'permission-approvals',
  sql: SQL,
};
