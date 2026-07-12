/**
 * Migration 0006 — agent process confinement audit column.
 *
 * Adds `agent_processes.confinement` recording the confinement mode a PTY
 * process ran under ('linux-bubblewrap' when sandboxed, 'none' when the
 * operator escape hatch REVDEV_SPAWN_CONFINEMENT=none was set). Nullable: rows
 * written before this migration predate the column and carry NULL. The
 * agent.spawn handler always writes it for new rows. "If an agent did it, there
 * is a receipt" (spec §8.1).
 */

import type { Migration } from '../storage/migrate.js';

const SQL = `
  ALTER TABLE agent_processes
    ADD COLUMN IF NOT EXISTS confinement TEXT;
`;

export const MIGRATION_0006: Migration = {
  version: 6,
  name: 'agent-process-confinement',
  sql: SQL,
};
