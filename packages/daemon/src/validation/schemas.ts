/**
 * Zod schemas for all daemon RPC method params.
 *
 * Each schema validates + constrains the input for one RPC method.
 * Field names are derived from the underlying DB columns (in
 * `storage/schema.ts`) and align with the RevealUI fleet's
 * agent-memory + agent-coordination contracts (see
 * `revealui/packages/contracts/src/agents`,
 * `revealui/packages/db/src/schema/agents.ts`,
 * `revealui/packages/mcp/src/servers/revealui-memory.ts`,
 * `revealui/packages/harnesses/src/server/rpc-server.ts` —
 * all use the typed-record framing
 * `memoryType`/`content`/`metadata`, not KV-store `key`/`value`).
 *
 * Drift between schemas and handler/bridge param names was tracked
 * in GAP-173 and reconciled in `fix/validation-schema-reconcile`.
 */

import { z } from 'zod';
import {
  MAX_BODY_LENGTH,
  MAX_IDS_BATCH,
  MAX_MEMORY_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PATH_LENGTH,
  MAX_PATHS_BATCH,
  MAX_PAYLOAD_SIZE,
  MAX_QUERY_LIMIT,
  MAX_SUBJECT_LENGTH,
  MAX_TTL_SECONDS,
} from './limits.js';

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

/** Safe file path: no traversal, reasonable length */
const safePath = z
  .string()
  .max(MAX_PATH_LENGTH)
  .refine((p) => !p.includes('..'), { message: 'Path traversal not allowed' })
  .refine((p) => !p.startsWith('/etc/') && !p.startsWith('/proc/') && !p.startsWith('/sys/'), {
    message: 'System paths not allowed',
  });

const agentId = z.string().max(MAX_NAME_LENGTH).optional();
const actorAgentId = z.string().max(MAX_NAME_LENGTH).optional();

/**
 * Task priority enum — canonical naming used by bridge MCP tool +
 * handler. Matches RevealUI contracts naming convention.
 */
const taskPriority = z.enum(['low', 'medium', 'high', 'critical']).optional();

/**
 * Mail priority enum — kept narrow (3 values) since mail is
 * coordination-tier, not the full task priority spectrum.
 */
const mailPriority = z.enum(['low', 'normal', 'high']).optional();

// ---------------------------------------------------------------------------
// Method schemas
// ---------------------------------------------------------------------------

export const schemas: Record<string, z.ZodType> = {
  // -- Session ----------------------------------------------------------------
  'session.register': z
    .object({
      agentId: z.string().max(MAX_NAME_LENGTH).optional(),
      agentName: z.string().max(MAX_NAME_LENGTH).optional(),
      workDir: z.string().max(MAX_PATH_LENGTH).optional(),
      backend: z.string().max(64).optional(),
      // Compat aliases — handler reads workDir||task and backend||env.
      task: z.string().max(MAX_PATH_LENGTH).optional(),
      env: z.string().max(64).optional(),
      pid: z.number().int().nonnegative().optional(),
      actorAgentId,
    })
    .passthrough(),

  'session.attach': z
    .object({
      // Canonical: sessionId (matches DB column `agent_sessions.id` and
      // session.register's response field). Handler accepts agentId as
      // alias since in this codebase sessionId == agentId.
      sessionId: z.string().max(MAX_NAME_LENGTH).optional(),
      agentId: z.string().max(MAX_NAME_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough()
    .refine((v) => v.sessionId || v.agentId, {
      message: 'session.attach requires sessionId or agentId',
    }),

  'session.list': z
    .object({
      // 'local' (default) queries the in-process PGlite; 'fleet' queries
      // Neon's coordination_sessions table for cross-machine peers.
      scope: z.enum(['local', 'fleet']).optional(),
      actorAgentId,
    })
    .passthrough(),

  'session.end': z
    .object({
      // Canonical: exitSummary (matches DB column `exit_summary`).
      // Handler accepts `summary` as alias.
      exitSummary: z.string().max(MAX_BODY_LENGTH).optional(),
      summary: z.string().max(MAX_BODY_LENGTH).optional(),
      // Compat: handler accepts sessionId or agentId for cross-session targeting.
      sessionId: z.string().max(MAX_NAME_LENGTH).optional(),
      agentId: z.string().max(MAX_NAME_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough(),

  'session.update': z
    .object({
      task: z.string().max(MAX_BODY_LENGTH).optional(),
      files: z.string().max(MAX_BODY_LENGTH).optional(),
      // Compat: handler accepts sessionId or agentId for cross-session targeting.
      sessionId: z.string().max(MAX_NAME_LENGTH).optional(),
      agentId: z.string().max(MAX_NAME_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough(),

  // -- Mail -------------------------------------------------------------------
  'mail.send': z
    .object({
      to: z.string().max(MAX_NAME_LENGTH).optional(),
      // Compat alias: handler accepts toAgent.
      toAgent: z.string().max(MAX_NAME_LENGTH).optional(),
      subject: z.string().max(MAX_SUBJECT_LENGTH),
      body: z.string().max(MAX_BODY_LENGTH),
      priority: mailPriority,
      actorAgentId,
    })
    .passthrough()
    .refine((v) => v.to || v.toAgent, {
      message: 'mail.send requires to or toAgent',
    }),

  'mail.inbox': z
    .object({
      agentId: agentId,
      unreadOnly: z.boolean().optional(),
      actorAgentId,
    })
    .passthrough(),

  'mail.broadcast': z
    .object({
      subject: z.string().max(MAX_SUBJECT_LENGTH),
      body: z.string().max(MAX_BODY_LENGTH),
      actorAgentId,
    })
    .passthrough(),

  'mail.markRead': z
    .object({
      messageIds: z.array(z.union([z.number().int(), z.string()])).max(MAX_IDS_BATCH),
      actorAgentId,
    })
    .passthrough(),

  // -- Files ------------------------------------------------------------------
  'files.reserve': z
    .object({
      filePath: safePath.optional(),
      paths: z.array(safePath).max(MAX_PATHS_BATCH).optional(),
      ttlSeconds: z.number().int().min(1).max(MAX_TTL_SECONDS).optional(),
      reason: z.string().max(MAX_SUBJECT_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough(),

  'files.check': z
    .object({
      filePath: safePath.optional(),
      paths: z.array(safePath).max(MAX_PATHS_BATCH).optional(),
      actorAgentId,
    })
    .passthrough(),

  'files.release': z
    .object({
      filePath: safePath.optional(),
      paths: z.array(safePath).max(MAX_PATHS_BATCH).optional(),
      actorAgentId,
    })
    .passthrough(),

  'files.list': z
    .object({
      agentId: z.string().max(MAX_NAME_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough(),

  // -- Tasks ------------------------------------------------------------------
  'tasks.create': z
    .object({
      taskId: z.string().max(MAX_NAME_LENGTH).optional(),
      title: z.string().max(MAX_SUBJECT_LENGTH).optional(),
      description: z.string().max(MAX_BODY_LENGTH).optional(),
      priority: taskPriority,
      full: z.string().max(MAX_BODY_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough(),

  'tasks.list': z
    .object({
      status: z.string().max(32).optional(),
      owner: z.string().max(MAX_NAME_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough(),

  'tasks.claim': z
    .object({
      taskId: z.string().max(MAX_NAME_LENGTH),
      actorAgentId,
    })
    .passthrough(),

  'tasks.complete': z
    .object({
      taskId: z.string().max(MAX_NAME_LENGTH),
      summary: z.string().max(MAX_BODY_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough(),

  'tasks.release': z
    .object({
      taskId: z.string().max(MAX_NAME_LENGTH),
      actorAgentId,
    })
    .passthrough(),

  // -- Events -----------------------------------------------------------------
  'events.log': z
    .object({
      eventType: z.string().max(128),
      payload: z
        .unknown()
        .refine((v) => JSON.stringify(v).length <= MAX_PAYLOAD_SIZE, {
          message: `Event payload exceeds ${MAX_PAYLOAD_SIZE} bytes`,
        })
        .optional(),
      // Handler accepts agentId override; falls back to ctx.agentId.
      agentId: z.string().max(MAX_NAME_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough(),

  'events.query': z
    .object({
      limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).optional(),
      since: z.string().max(64).optional(),
      actorAgentId,
    })
    .passthrough(),

  // -- Memory -----------------------------------------------------------------
  // Field names match DB columns (`agent_memory.memory_type`, `.content`,
  // `.metadata`) and the RevealUI fleet's typed-record framing
  // (contracts/agents, db/schema/agents, mcp/servers/revealui-memory,
  // harnesses/server/rpc-server). Pre-#20 colloquial `key`/`value`/`tags`
  // names were retired in fix/validation-schema-reconcile (GAP-173).
  'memory.store': z
    .object({
      memoryType: z.string().max(64),
      content: z.string().max(MAX_MEMORY_LENGTH),
      metadata: z.record(z.string(), z.unknown()).optional(),
      actorAgentId,
    })
    .passthrough(),

  'memory.query': z
    .object({
      memoryType: z.string().max(64).optional(),
      // Full-text content filter — distinct from memoryType (categorical).
      query: z.string().max(MAX_NAME_LENGTH).optional(),
      // Tag filter — searches metadata.tags JSONB.
      tags: z.array(z.string().max(64)).max(MAX_IDS_BATCH).optional(),
      limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).optional(),
      actorAgentId,
    })
    .passthrough(),

  // -- Inference --------------------------------------------------------------
  'inference.pull': z
    .object({
      model: z.string().max(256),
      actorAgentId,
    })
    .passthrough(),

  'inference.start': z
    .object({
      model: z.string().max(256),
      actorAgentId,
    })
    .passthrough(),

  'inference.stop': z
    .object({
      model: z.string().max(256),
      actorAgentId,
    })
    .passthrough(),

  'inference.chat': z
    .object({
      model: z.string().max(256),
      messages: z
        .array(
          z.object({
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string().max(MAX_MEMORY_LENGTH),
          }),
        )
        .max(100),
      actorAgentId,
    })
    .passthrough(),

  'inference.generate': z
    .object({
      model: z.string().max(256),
      prompt: z.string().max(MAX_MEMORY_LENGTH),
      actorAgentId,
    })
    .passthrough(),

  // -- Worktrees --------------------------------------------------------------
  'worktree.create': z
    .object({
      branch: z.string().max(256),
      baseBranch: z.string().max(256).optional(),
      // Optional override for derived worktree path.
      path: z.string().max(MAX_PATH_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough(),

  'worktree.list': z
    .object({
      // Filter by owning agent; handler defaults to all when omitted.
      agentId: z.string().max(MAX_NAME_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough(),

  'worktree.remove': z
    .object({
      // Required: worktree.remove handler throws when branch is absent.
      branch: z.string().max(256),
      actorAgentId,
    })
    .passthrough(),

  // -- Merge ------------------------------------------------------------------
  'merge.request': z
    .object({
      taskId: z.string().max(MAX_NAME_LENGTH).optional(),
      // Canonical: sourceBranch (matches DB column `merge_requests.source_branch`).
      sourceBranch: z.string().max(256).optional(),
      // Compat alias — handler accepts `branch` as alias for sourceBranch.
      branch: z.string().max(256).optional(),
      // Canonical: baseBranch (matches DB column `merge_requests.base_branch`).
      baseBranch: z.string().max(256).optional(),
      // Compat alias — handler accepts `targetBranch` as alias for baseBranch.
      targetBranch: z.string().max(256).optional(),
      description: z.string().max(MAX_BODY_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough()
    .refine((v) => v.sourceBranch || v.branch, {
      message: 'merge.request requires sourceBranch or branch',
    }),

  'merge.status': z
    .object({
      mergeId: z.string().max(MAX_NAME_LENGTH),
      actorAgentId,
    })
    .passthrough(),

  'merge.list': z
    .object({
      status: z.string().max(32).optional(),
      // Filter by owning agent; handler defaults to all when omitted.
      agentId: z.string().max(MAX_NAME_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough(),

  'merge.update': z
    .object({
      mergeId: z.string().max(MAX_NAME_LENGTH),
      status: z.string().max(32).optional(),
      prNumber: z.number().int().optional(),
      prUrl: z.string().max(1024).optional(),
      errorMessage: z.string().max(MAX_BODY_LENGTH).optional(),
      ciOutput: z.string().max(MAX_BODY_LENGTH).optional(),
      actorAgentId,
    })
    .passthrough(),
};
