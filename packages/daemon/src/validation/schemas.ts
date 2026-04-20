/**
 * Zod schemas for all daemon RPC method params.
 *
 * Each schema validates + constrains the input for one RPC method.
 * Uses @revealui/contracts where shared schemas exist.
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

// ---------------------------------------------------------------------------
// Method schemas
// ---------------------------------------------------------------------------

export const schemas: Record<string, z.ZodType> = {
  // -- Session ----------------------------------------------------------------
  'session.register': z.object({
    agentId: z.string().max(MAX_NAME_LENGTH).optional(),
    agentName: z.string().max(MAX_NAME_LENGTH).optional(),
    workDir: z.string().max(MAX_PATH_LENGTH).optional(),
    backend: z.string().max(64).optional(),
    actorAgentId,
  }).passthrough(),

  'session.attach': z.object({
    sessionId: z.string().max(MAX_NAME_LENGTH),
    actorAgentId,
  }).passthrough(),

  'session.list': z.object({
    actorAgentId,
  }).passthrough(),

  'session.end': z.object({
    exitSummary: z.string().max(MAX_BODY_LENGTH).optional(),
    actorAgentId,
  }).passthrough(),

  'session.update': z.object({
    task: z.string().max(MAX_BODY_LENGTH).optional(),
    files: z.string().max(MAX_BODY_LENGTH).optional(),
    actorAgentId,
  }).passthrough(),

  // -- Mail -------------------------------------------------------------------
  'mail.send': z.object({
    to: z.string().max(MAX_NAME_LENGTH),
    subject: z.string().max(MAX_SUBJECT_LENGTH),
    body: z.string().max(MAX_BODY_LENGTH),
    actorAgentId,
  }).passthrough(),

  'mail.inbox': z.object({
    agentId: agentId,
    unreadOnly: z.boolean().optional(),
    actorAgentId,
  }).passthrough(),

  'mail.broadcast': z.object({
    subject: z.string().max(MAX_SUBJECT_LENGTH),
    body: z.string().max(MAX_BODY_LENGTH),
    actorAgentId,
  }).passthrough(),

  'mail.markRead': z.object({
    messageIds: z.array(z.union([z.number().int(), z.string()])).max(MAX_IDS_BATCH),
    actorAgentId,
  }).passthrough(),

  // -- Files ------------------------------------------------------------------
  'files.reserve': z.object({
    filePath: safePath.optional(),
    paths: z.array(safePath).max(MAX_PATHS_BATCH).optional(),
    ttlSeconds: z.number().int().min(1).max(MAX_TTL_SECONDS).optional(),
    reason: z.string().max(MAX_SUBJECT_LENGTH).optional(),
    actorAgentId,
  }).passthrough(),

  'files.check': z.object({
    filePath: safePath.optional(),
    paths: z.array(safePath).max(MAX_PATHS_BATCH).optional(),
    actorAgentId,
  }).passthrough(),

  'files.release': z.object({
    filePath: safePath.optional(),
    paths: z.array(safePath).max(MAX_PATHS_BATCH).optional(),
    actorAgentId,
  }).passthrough(),

  'files.list': z.object({
    agentId: z.string().max(MAX_NAME_LENGTH).optional(),
    actorAgentId,
  }).passthrough(),

  // -- Tasks ------------------------------------------------------------------
  'tasks.create': z.object({
    taskId: z.string().max(MAX_NAME_LENGTH).optional(),
    title: z.string().max(MAX_SUBJECT_LENGTH).optional(),
    description: z.string().max(MAX_BODY_LENGTH).optional(),
    full: z.string().max(MAX_BODY_LENGTH).optional(),
    actorAgentId,
  }).passthrough(),

  'tasks.list': z.object({
    status: z.string().max(32).optional(),
    owner: z.string().max(MAX_NAME_LENGTH).optional(),
    actorAgentId,
  }).passthrough(),

  'tasks.claim': z.object({
    taskId: z.string().max(MAX_NAME_LENGTH),
    actorAgentId,
  }).passthrough(),

  'tasks.complete': z.object({
    taskId: z.string().max(MAX_NAME_LENGTH),
    actorAgentId,
  }).passthrough(),

  'tasks.release': z.object({
    taskId: z.string().max(MAX_NAME_LENGTH),
    actorAgentId,
  }).passthrough(),

  // -- Events -----------------------------------------------------------------
  'events.log': z.object({
    eventType: z.string().max(128),
    payload: z.unknown().refine(
      (v) => JSON.stringify(v).length <= MAX_PAYLOAD_SIZE,
      { message: `Event payload exceeds ${MAX_PAYLOAD_SIZE} bytes` },
    ).optional(),
    actorAgentId,
  }).passthrough(),

  'events.query': z.object({
    limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).optional(),
    since: z.string().max(64).optional(),
    actorAgentId,
  }).passthrough(),

  // -- Memory -----------------------------------------------------------------
  'memory.store': z.object({
    memoryType: z.string().max(64),
    content: z.string().max(MAX_MEMORY_LENGTH),
    metadata: z.record(z.string(), z.unknown()).optional(),
    actorAgentId,
  }).passthrough(),

  'memory.query': z.object({
    memoryType: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).optional(),
    actorAgentId,
  }).passthrough(),

  // -- Inference --------------------------------------------------------------
  'inference.pull': z.object({
    model: z.string().max(256),
    actorAgentId,
  }).passthrough(),

  'inference.start': z.object({
    model: z.string().max(256),
    actorAgentId,
  }).passthrough(),

  'inference.stop': z.object({
    model: z.string().max(256),
    actorAgentId,
  }).passthrough(),

  'inference.chat': z.object({
    model: z.string().max(256),
    messages: z.array(z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string().max(MAX_MEMORY_LENGTH),
    })).max(100),
    actorAgentId,
  }).passthrough(),

  'inference.generate': z.object({
    model: z.string().max(256),
    prompt: z.string().max(MAX_MEMORY_LENGTH),
    actorAgentId,
  }).passthrough(),

  // -- Worktrees --------------------------------------------------------------
  'worktree.create': z.object({
    branch: z.string().max(256),
    baseBranch: z.string().max(256).optional(),
    actorAgentId,
  }).passthrough(),

  'worktree.list': z.object({
    actorAgentId,
  }).passthrough(),

  'worktree.remove': z.object({
    actorAgentId,
  }).passthrough(),

  // -- Merge ------------------------------------------------------------------
  'merge.request': z.object({
    taskId: z.string().max(MAX_NAME_LENGTH).optional(),
    sourceBranch: z.string().max(256),
    baseBranch: z.string().max(256).optional(),
    actorAgentId,
  }).passthrough(),

  'merge.status': z.object({
    mergeId: z.string().max(MAX_NAME_LENGTH),
    actorAgentId,
  }).passthrough(),

  'merge.list': z.object({
    status: z.string().max(32).optional(),
    actorAgentId,
  }).passthrough(),

  'merge.update': z.object({
    mergeId: z.string().max(MAX_NAME_LENGTH),
    status: z.string().max(32).optional(),
    prNumber: z.number().int().optional(),
    prUrl: z.string().max(1024).optional(),
    errorMessage: z.string().max(MAX_BODY_LENGTH).optional(),
    ciOutput: z.string().max(MAX_BODY_LENGTH).optional(),
    actorAgentId,
  }).passthrough(),
};
