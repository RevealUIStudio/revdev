/**
 * Migration 0016 — kg_communities + Layer-3 reconcile cursor (GAP-349 P5 leftover).
 *
 * Communities are class-3 derived state (never Electric-synced). Rows are
 * invalidated, not deleted. The reconcile cursor remembers how far the
 * shared_facts → kg_episodes loop has read.
 */

import type { Migration } from '../storage/migrate.js';

export const MIGRATION_0016: Migration = {
  version: 16,
  name: 'graph-communities',
  sql: `
    CREATE TABLE IF NOT EXISTS kg_communities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      summary TEXT,
      node_ids JSONB NOT NULL DEFAULT '[]',
      node_count INTEGER NOT NULL DEFAULT 0,
      algorithm TEXT NOT NULL DEFAULT 'connected-components',
      computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      invalidated_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS kg_communities_current_idx
      ON kg_communities (computed_at DESC)
      WHERE invalidated_at IS NULL;

    CREATE TABLE IF NOT EXISTS kg_reconcile_cursor (
      source TEXT PRIMARY KEY,
      last_created_at TIMESTAMPTZ,
      last_id TEXT,
      last_run_at TIMESTAMPTZ,
      last_error TEXT,
      ingested INTEGER NOT NULL DEFAULT 0
    );
  `,
};
