/**
 * Daemon database schema — Drizzle ORM table definitions.
 *
 * This is the single source of truth for the daemon's PGlite database.
 * Drizzle-kit generates migrations from changes to these definitions.
 *
 * Run `pnpm --filter @revdev/daemon db:generate` to generate a migration
 * after modifying this file.
 */

import { boolean, index, integer, jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Agent Sessions
// ---------------------------------------------------------------------------

export const agentSessions = pgTable('agent_sessions', {
  id: text('id').primaryKey(),
  env: text('env').notNull().default(''),
  task: text('task').notNull().default('(starting)'),
  files: text('files').notNull().default(''),
  pid: integer('pid'),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  endedAt: timestamp('ended_at'),
  exitSummary: text('exit_summary'),
});

// ---------------------------------------------------------------------------
// Agent Messages (inter-agent mail)
// ---------------------------------------------------------------------------

export const agentMessages = pgTable(
  'agent_messages',
  {
    id: serial('id').primaryKey(),
    fromAgent: text('from_agent').notNull(),
    toAgent: text('to_agent').notNull(),
    subject: text('subject').notNull().default(''),
    body: text('body').notNull().default(''),
    read: boolean('read').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_messages_to_unread').on(table.toAgent, table.read),
  ],
);

// ---------------------------------------------------------------------------
// File Reservations (multi-agent conflict prevention)
// ---------------------------------------------------------------------------

export const fileReservations = pgTable(
  'file_reservations',
  {
    filePath: text('file_path').primaryKey(),
    agentId: text('agent_id').notNull(),
    reservedAt: timestamp('reserved_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at').notNull(),
    reason: text('reason').notNull().default(''),
  },
  (table) => [
    index('idx_reservations_agent').on(table.agentId),
  ],
);

// ---------------------------------------------------------------------------
// Tasks (coordination task board)
// ---------------------------------------------------------------------------

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    description: text('description').notNull().default(''),
    status: text('status').notNull().default('open'),
    owner: text('owner'),
    claimedAt: timestamp('claimed_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_tasks_status').on(table.status),
    index('idx_tasks_owner').on(table.owner),
  ],
);

// ---------------------------------------------------------------------------
// Events (audit log)
// ---------------------------------------------------------------------------

export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_events_agent').on(table.agentId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Worktrees (git branch isolation)
// ---------------------------------------------------------------------------

export const worktrees = pgTable('worktrees', {
  agentId: text('agent_id').primaryKey(),
  branch: text('branch').notNull(),
  worktreePath: text('worktree_path').notNull(),
  baseBranch: text('base_branch').notNull().default('test'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Agent Memory (long-term knowledge persistence)
// ---------------------------------------------------------------------------

export const agentMemory = pgTable(
  'agent_memory',
  {
    id: serial('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    memoryType: text('memory_type').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_memory_agent_type').on(table.agentId, table.memoryType, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Merge Requests (PR pipeline tracking)
// ---------------------------------------------------------------------------

export const mergeRequests = pgTable(
  'merge_requests',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    taskId: text('task_id'),
    sourceBranch: text('source_branch').notNull(),
    baseBranch: text('base_branch').notNull().default('test'),
    status: text('status').notNull().default('pending'),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    retryCount: integer('retry_count').notNull().default(0),
    errorMessage: text('error_message'),
    ciOutput: text('ci_output'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_merge_requests_agent').on(table.agentId, table.status),
    index('idx_merge_requests_branch').on(table.sourceBranch),
    index('idx_merge_requests_pr').on(table.prNumber),
  ],
);

// ---------------------------------------------------------------------------
// Legacy SCHEMA_SQL export (for backward compat during migration period)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use Drizzle schema + migrations instead.
 * Kept for existing startDaemon() to work until fully migrated to Drizzle push.
 */
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
