import type { Migration } from '../storage/migrate.js';

export const MIGRATION_0002: Migration = {
  version: 2,
  name: 'key-origin',
  sql: `
    ALTER TABLE agent_identity ADD COLUMN IF NOT EXISTS key_origin TEXT NOT NULL DEFAULT 'daemon';
    ALTER TABLE agent_identity ADD CONSTRAINT agent_identity_key_origin_check CHECK (key_origin IN ('client', 'daemon'));
  `,
};
