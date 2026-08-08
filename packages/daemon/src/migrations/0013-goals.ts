/**
 * Migration 0013 — goals + goal_criteria (roadmap-goal-spine PR0).
 *
 * Durable goal store for GoalHarness. Ported field map from the retired
 * @revealui/harnesses DaemonStore goals tables (deleted under daemon-ownership
 * ADR). Propose-only: criteria may link claimable `tasks` rows; no spawn.
 */

import type { Migration } from '../storage/migrate.js';

const SQL = `
  CREATE TABLE IF NOT EXISTS goals (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'open',
    priority       TEXT NOT NULL DEFAULT 'medium',
    owner          TEXT NOT NULL DEFAULT 'agent',
    parent_goal_id TEXT,
    blocked_by     JSONB NOT NULL DEFAULT '[]',
    created_by     TEXT NOT NULL DEFAULT '',
    status_reason  TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMP NOT NULL DEFAULT NOW(),
    closed_at      TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_goals_status
    ON goals (status);

  CREATE INDEX IF NOT EXISTS idx_goals_parent
    ON goals (parent_goal_id) WHERE parent_goal_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS goal_criteria (
    id           TEXT PRIMARY KEY,
    goal_id      TEXT NOT NULL,
    description  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    evidence     TEXT NOT NULL DEFAULT '',
    verified_by  TEXT,
    verified_at  TIMESTAMP,
    task_id      TEXT,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_goal_criteria_goal
    ON goal_criteria (goal_id);
`;

export const MIGRATION_0013: Migration = {
  version: 13,
  name: 'goals',
  sql: SQL,
};
