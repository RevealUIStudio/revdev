/**
 * Migration 0009 — agent-scoped permission grants (GAP-294 §9).
 *
 * Operator-issued scope grants for sessions in agent-scoped mode.
 * A grant may cover consequential by class; critical only by explicit method.
 */

import type { Migration } from '../storage/migrate.js';

const SQL = `
  CREATE TABLE IF NOT EXISTS permission_grants (
    id                 TEXT PRIMARY KEY,
    grantee_agent_id   TEXT NOT NULL,
    classes            JSONB NOT NULL DEFAULT '[]'::jsonb,
    methods            JSONB NOT NULL DEFAULT '[]'::jsonb,
    root_scope         TEXT,
    expires_at         TIMESTAMP NOT NULL,
    max_uses           INTEGER,
    uses_remaining     INTEGER,
    issued_by          TEXT NOT NULL,
    issued_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    revoked_at         TIMESTAMP,
    status             TEXT NOT NULL DEFAULT 'active'
  );

  CREATE INDEX IF NOT EXISTS idx_permission_grants_grantee_status
    ON permission_grants (grantee_agent_id, status, expires_at);
`;

export const MIGRATION_0009: Migration = {
  version: 9,
  name: 'permission-grants',
  sql: SQL,
};
