/**
 * Migration 0012 — session fidelity snapshots (GAP-342).
 *
 * Five-section fidelity records keyed by daemon session id (id-match get,
 * never mtime). Portable shape with the Claude-side /snapshot skill.
 */

import type { Migration } from '../storage/migrate.js';

const SQL = `
  CREATE TABLE IF NOT EXISTS session_fidelity_snapshots (
    session_id   TEXT PRIMARY KEY,
    agent_id     TEXT NOT NULL,
    sections     JSONB NOT NULL,
    mechanical   JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_session_fidelity_snapshots_updated
    ON session_fidelity_snapshots (updated_at);

  CREATE INDEX IF NOT EXISTS idx_session_fidelity_snapshots_agent
    ON session_fidelity_snapshots (agent_id, updated_at DESC);
`;

export const MIGRATION_0012: Migration = {
  version: 12,
  name: 'session-fidelity-snapshots',
  sql: SQL,
};
