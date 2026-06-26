/**
 * Migration 0002 — agent process tables.
 *
 * Adds `agent_processes` (metadata + lifecycle for PTY-spawned processes)
 * and `agent_process_output` (poll-based output buffer for agent.output).
 */

import type { Migration } from '../storage/migrate.js';

const SQL = `
  CREATE TABLE IF NOT EXISTS agent_processes (
    id           TEXT PRIMARY KEY,
    owner_agent  TEXT NOT NULL,
    command      TEXT NOT NULL,
    args         JSONB NOT NULL DEFAULT '[]',
    cwd          TEXT NOT NULL,
    pid          INTEGER,
    status       TEXT NOT NULL DEFAULT 'running',
    exit_code    INTEGER,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    ended_at     TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_agent_processes_owner
    ON agent_processes (owner_agent, status);

  CREATE TABLE IF NOT EXISTS agent_process_output (
    id          BIGSERIAL PRIMARY KEY,
    process_id  TEXT NOT NULL REFERENCES agent_processes(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    stream      TEXT NOT NULL DEFAULT 'pty',
    chunk       TEXT NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_agent_process_output_process_seq
    ON agent_process_output (process_id, seq);
`;

export const MIGRATION_0002: Migration = {
  version: 2,
  name: 'agent-processes',
  sql: SQL,
};
