/**
 * Migration 0011 — GAP-269 spawned agent identity.
 *
 * 1. `agent_identity.key_origin` may be `spawned` (daemon-minted principal
 *    created at agent.spawn time, distinct from the parent).
 * 2. `agent_processes.parent_agent` records the supervisor who called spawn.
 *    `owner_agent` becomes the child's agent id for new rows; ownership
 *    checks accept parent OR child so Studio can keep driving the PTY while
 *    the child signs as itself for peer-agent work.
 */

import type { Migration } from '../storage/migrate.js';

const SQL = `
  ALTER TABLE agent_identity DROP CONSTRAINT IF EXISTS agent_identity_key_origin_check;
  ALTER TABLE agent_identity
    ADD CONSTRAINT agent_identity_key_origin_check
    CHECK (key_origin IN ('client', 'daemon', 'spawned'));

  ALTER TABLE agent_processes
    ADD COLUMN IF NOT EXISTS parent_agent TEXT;

  -- Legacy rows: the supervisor was stored as owner_agent.
  UPDATE agent_processes
     SET parent_agent = owner_agent
   WHERE parent_agent IS NULL;

  CREATE INDEX IF NOT EXISTS idx_agent_processes_parent
    ON agent_processes (parent_agent, status);
`;

export const MIGRATION_0011: Migration = {
  version: 11,
  name: 'spawned-agent-identity',
  sql: SQL,
};
