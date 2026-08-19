/**
 * Migration 0014 — PGlite knowledge-graph site replica (GAP-349 P5).
 *
 * Portable DDL (embedding as real[], no HNSW) from
 * `@revealui/knowledge-graph/ddl`. Same tables as Neon 0021+0022 so
 * ingest/search/outbox APIs run locally. Spec called this "migration 0007";
 * 0007 is already permission-approvals in this daemon.
 */

import { kgDdlStatements } from '@revealui/knowledge-graph/ddl';
import type { Migration } from '../storage/migrate.js';

const SQL = `${kgDdlStatements({ variant: 'portable' }).join(';\n')};`;

export const MIGRATION_0014: Migration = {
  version: 14,
  name: 'knowledge-graph-replica',
  sql: SQL,
};
