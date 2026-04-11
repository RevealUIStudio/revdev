/**
 * PGlite schema SQL for the daemon database.
 *
 * Uses raw SQL (no ORM) for minimal dependencies.
 * PGlite runs in-process — no external database needed.
 */

/** SQL statements to initialize the daemon database. */
export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_sessions (
    id            TEXT PRIMARY KEY,
    env           TEXT NOT NULL DEFAULT '',
    task          TEXT NOT NULL DEFAULT '(starting)',
    files         TEXT NOT NULL DEFAULT '',
    pid           INTEGER,
    started_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    ended_at      TIMESTAMP,
    exit_summary  TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_messages (
    id            SERIAL PRIMARY KEY,
    from_agent    TEXT NOT NULL,
    to_agent      TEXT NOT NULL,
    subject       TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL DEFAULT '',
    read          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_messages_to_unread
    ON agent_messages (to_agent, read) WHERE read = FALSE;

  CREATE TABLE IF NOT EXISTS file_reservations (
    file_path     TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    reserved_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMP NOT NULL,
    reason        TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_reservations_agent
    ON file_reservations (agent_id);

  CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    description   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'open',
    owner         TEXT,
    claimed_at    TIMESTAMP,
    completed_at  TIMESTAMP,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status
    ON tasks (status);

  CREATE INDEX IF NOT EXISTS idx_tasks_owner
    ON tasks (owner) WHERE owner IS NOT NULL;

  CREATE TABLE IF NOT EXISTS events (
    id            SERIAL PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    payload       JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_events_agent
    ON events (agent_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS worktrees (
    agent_id      TEXT PRIMARY KEY,
    branch        TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    base_branch   TEXT NOT NULL DEFAULT 'test',
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS agent_memory (
    id            SERIAL PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    memory_type   TEXT NOT NULL,
    content       TEXT NOT NULL,
    metadata      JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_memory_agent_type
    ON agent_memory (agent_id, memory_type, created_at DESC);

  CREATE TABLE IF NOT EXISTS merge_requests (
    id            TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    task_id       TEXT,
    source_branch TEXT NOT NULL,
    base_branch   TEXT NOT NULL DEFAULT 'test',
    status        TEXT NOT NULL DEFAULT 'pending',
    pr_number     INTEGER,
    pr_url        TEXT,
    retry_count   INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    ci_output     TEXT,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_merge_requests_agent
    ON merge_requests (agent_id, status);

  CREATE INDEX IF NOT EXISTS idx_merge_requests_branch
    ON merge_requests (source_branch);

  CREATE INDEX IF NOT EXISTS idx_merge_requests_pr
    ON merge_requests (pr_number) WHERE pr_number IS NOT NULL;
`;
