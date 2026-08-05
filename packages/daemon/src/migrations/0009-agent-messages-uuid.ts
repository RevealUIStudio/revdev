/**
 * Migration 0009 — agent_messages.id SERIAL → TEXT UUID (GAP-176).
 *
 * Aligns PGlite mail row ids with Neon coordination_mail UUID PKs so
 * mail.markRead dual-write can UPDATE by id without subject/body heuristics.
 * Existing rows get deterministic UUIDs derived from the old serial id
 * (preserves uniqueness; new inserts use crypto.randomUUID in handlers).
 */

import type { Migration } from '../storage/migrate.js';

const SQL = `
  CREATE TABLE IF NOT EXISTS agent_messages_uuid (
    id            TEXT PRIMARY KEY,
    from_agent    TEXT NOT NULL,
    to_agent      TEXT NOT NULL,
    subject       TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL DEFAULT '',
    read          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
  );

  INSERT INTO agent_messages_uuid (id, from_agent, to_agent, subject, body, read, created_at)
  SELECT
    gen_random_uuid()::text,
    from_agent,
    to_agent,
    subject,
    body,
    read,
    created_at
  FROM agent_messages
  ORDER BY id ASC;

  DROP TABLE agent_messages;

  ALTER TABLE agent_messages_uuid RENAME TO agent_messages;

  CREATE INDEX IF NOT EXISTS idx_messages_to_unread
    ON agent_messages (to_agent, read) WHERE read = FALSE;
`;

export const MIGRATION_0009: Migration = {
  version: 9,
  name: 'agent-messages-uuid',
  sql: SQL,
};
