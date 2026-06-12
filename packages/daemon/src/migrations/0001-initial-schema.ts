/**
 * Migration 0001 — frozen baseline.
 *
 * Wraps the original SCHEMA_SQL (12 tables + indexes, everything
 * IF NOT EXISTS) so databases created before the migration system adopt
 * it as a no-op that records version 1. Do not edit the baseline —
 * schema changes are new migrations.
 */

import type { Migration } from '../storage/migrate.js';
import { SCHEMA_SQL } from '../storage/schema.js';

export const MIGRATION_0001: Migration = {
  version: 1,
  name: 'initial-schema',
  sql: SCHEMA_SQL,
};
