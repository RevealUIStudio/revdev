import type { Migration } from '../storage/migrate.js';

export const MIGRATION_0003: Migration = {
  version: 3,
  name: 'project-roots',
  sql: `
    CREATE TABLE IF NOT EXISTS project_roots (
      dev BIGINT NOT NULL,
      ino BIGINT NOT NULL,
      real_path TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(dev, ino)
    );
    CREATE INDEX IF NOT EXISTS project_roots_agent_id_idx ON project_roots(agent_id);
  `,
};
