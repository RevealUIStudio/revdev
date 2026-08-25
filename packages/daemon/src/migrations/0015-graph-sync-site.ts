/**
 * Migration 0015 — durable graph site id + Electric shape cursors (GAP-349 P5b).
 *
 * Spec §8.2: each replica gets a durable siteId (not only hostname/env),
 * and down-sync remembers Electric handle/offset for anti-entropy resume.
 * Singleton graph_site is one row per daemon, not per agent_identity.
 */

import type { Migration } from '../storage/migrate.js';

export const MIGRATION_0015: Migration = {
  version: 15,
  name: 'graph-sync-site',
  sql: `
    CREATE TABLE IF NOT EXISTS graph_site (
      singleton TEXT PRIMARY KEY CHECK (singleton = 'local'),
      site_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS kg_shape_cursors (
      table_name TEXT PRIMARY KEY,
      handle TEXT,
      shape_offset TEXT NOT NULL DEFAULT '-1',
      last_pulled_at TIMESTAMPTZ,
      last_error TEXT
    );
  `,
};
