/**
 * Permission modes — action-class map + shadow/enforce gate (GAP-294).
 *
 * Spec: `.jv` docs/gap-specs/GAP-294-permission-modes-design.md §5–§10.
 *
 * Phase 0: classify + `permission.would_*` events (never blocks when mode=shadow).
 * Phase 1: manual/auto enforcement with pending_approvals + -32004 reject-with-receipt.
 */

import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { RPC_METHODS } from '@revdev/protocol';
import { createLogger } from '@revealui/utils/logger';
import { hashParams } from './agent-identity-crypto.js';

const log = createLogger({ service: 'revdev-daemon/permission' });

/** Spec §6 — approval-required (shares code with untrusted-client; data.kind distinguishes). */
export const APPROVAL_REQUIRED_CODE = -32004;

/** Pending request TTL (ms). */
export const PENDING_TTL_MS = 30 * 60 * 1000;
/** Approved-but-unconsumed TTL (ms). */
export const APPROVAL_CONSUME_TTL_MS = 5 * 60 * 1000;
/** Max pending rows per agent. */
export const MAX_PENDING_PER_AGENT = 10;

export type ActionClass = 'routine' | 'consequential' | 'critical';
export type PermissionMode = 'shadow' | 'manual' | 'auto' | 'agent-scoped';
export type ShadowWould = 'allow' | 'require_approval' | 'deny';

/**
 * Explicit method → action class. No wildcards. Unmapped → critical (I2).
 * Authority: GAP-294 design §5 (owner countersigned 2026-07-18).
 */
export const METHOD_ACTION_CLASS = new Map<string, ActionClass>([
  // routine
  ['ping', 'routine'],
  ['session.register', 'routine'],
  ['session.attach', 'routine'],
  ['session.list', 'routine'],
  ['session.update', 'routine'],
  ['mail.send', 'routine'],
  ['mail.broadcast', 'routine'],
  ['mail.inbox', 'routine'],
  ['mail.markRead', 'routine'],
  ['files.reserve', 'routine'],
  ['files.check', 'routine'],
  ['files.release', 'routine'],
  ['files.list', 'routine'],
  ['tasks.create', 'routine'],
  ['tasks.claim', 'routine'],
  ['tasks.complete', 'routine'],
  ['tasks.release', 'routine'],
  ['tasks.list', 'routine'],
  ['events.log', 'routine'],
  ['events.query', 'routine'],
  ['memory.store', 'routine'],
  ['memory.query', 'routine'],
  ['harness.health', 'routine'],
  ['inference.status', 'routine'],
  ['inference.chat', 'routine'],
  ['inference.generate', 'routine'],
  ['file.read', 'routine'],
  ['file.stat', 'routine'],
  ['git.status', 'routine'],
  ['git.diffFile', 'routine'],
  ['git.diffContent', 'routine'],
  ['git.readBlobAtHead', 'routine'],
  ['git.readBlobAtIndex', 'routine'],
  ['git.listBranches', 'routine'],
  ['git.log', 'routine'],
  ['worktree.list', 'routine'],
  ['merge.status', 'routine'],
  ['merge.list', 'routine'],
  ['agent.output', 'routine'],
  ['agent.resize', 'routine'],
  ['agent.stop', 'routine'],
  ['agent.list', 'routine'],
  // consequential
  ['file.write', 'consequential'],
  ['file.delete', 'consequential'],
  ['git.stageFile', 'consequential'],
  ['git.unstageFile', 'consequential'],
  ['git.createBranch', 'consequential'],
  ['git.switchBranch', 'consequential'],
  ['git.deleteBranch', 'consequential'],
  ['git.commit', 'consequential'],
  ['git.pull', 'consequential'],
  ['worktree.create', 'consequential'],
  ['agent.input', 'consequential'],
  ['merge.request', 'consequential'],
  ['merge.update', 'consequential'],
  ['agent.remove', 'consequential'],
  // critical
  ['agent.spawn', 'critical'],
  ['git.push', 'critical'],
  ['git.discardFile', 'critical'],
  ['project.open', 'critical'],
  ['project.grant', 'critical'],
  ['project.revoke', 'critical'],
  ['worktree.remove', 'critical'],
  ['harness.prune', 'critical'],
  ['identity.rotate', 'critical'],
  ['session.end', 'critical'],
  ['inference.pull', 'critical'],
  ['inference.delete', 'critical'],
  ['inference.start', 'critical'],
  ['inference.stop', 'critical'],
  // future gate controls (not registered yet — mapped for enumeration honesty)
  ['permission.pending', 'routine'],
  ['permission.decide', 'critical'],
  ['permission.setMode', 'critical'],
]);

/** Fail closed: unmapped method is critical (spec §5 / I2). */
export function classifyMethod(method: string): ActionClass {
  return METHOD_ACTION_CLASS.get(method) ?? 'critical';
}

/**
 * Shadow simulation of **manual** mode (most interesting observation):
 * routine → allow; consequential/critical → would require approval.
 * Deny is reserved for auto deny-list (not wired in Phase 0).
 */
export function shadowWouldManual(actionClass: ActionClass): ShadowWould {
  if (actionClass === 'routine') return 'allow';
  return 'require_approval';
}

/**
 * Shadow simulation of **auto** mode (deterministic policy without root probe):
 * routine → allow; consequential → allow (real root check is handler-side);
 * critical → require_approval (policy floor).
 */
export function shadowWouldAuto(actionClass: ActionClass): ShadowWould {
  if (actionClass === 'critical') return 'require_approval';
  return 'allow';
}

export function resolvePermissionMode(env: NodeJS.ProcessEnv = process.env): PermissionMode {
  const raw = (env.REVDEV_PERMISSION_MODE ?? '').trim().toLowerCase();
  if (raw === 'manual' || raw === 'auto' || raw === 'agent-scoped' || raw === 'shadow') {
    return raw;
  }
  // Unset / unknown → shadow (Phase 0 default; never blocks).
  return 'shadow';
}

/**
 * Which mode the shadow *simulates* for would_* rows when running in shadow.
 * Defaults to manual (highest-friction observation). Override with
 * REVDEV_PERMISSION_SHADOW_AS=auto.
 */
export function resolveShadowAs(env: NodeJS.ProcessEnv = process.env): 'manual' | 'auto' {
  const raw = (env.REVDEV_PERMISSION_SHADOW_AS ?? 'manual').trim().toLowerCase();
  return raw === 'auto' ? 'auto' : 'manual';
}

export interface PermissionShadowResult {
  actionClass: ActionClass;
  would: ShadowWould;
  simulatedMode: 'manual' | 'auto';
  eventType:
    | 'permission.would_allow'
    | 'permission.would_require_approval'
    | 'permission.would_deny';
}

export function evaluateShadow(
  method: string,
  env: NodeJS.ProcessEnv = process.env,
): PermissionShadowResult {
  const actionClass = classifyMethod(method);
  const simulatedMode = resolveShadowAs(env);
  const would =
    simulatedMode === 'auto' ? shadowWouldAuto(actionClass) : shadowWouldManual(actionClass);
  const eventType =
    would === 'allow'
      ? 'permission.would_allow'
      : would === 'deny'
        ? 'permission.would_deny'
        : 'permission.would_require_approval';
  return { actionClass, would, simulatedMode, eventType };
}

/**
 * Best-effort audit insert. Never throws into the RPC path.
 */
export function emitPermissionShadowEvent(
  db: PGlite,
  agentId: string | null,
  method: string,
  result: PermissionShadowResult,
): void {
  const payload = {
    method,
    actionClass: result.actionClass,
    would: result.would,
    simulatedMode: result.simulatedMode,
    gateMode: 'shadow',
  };
  void db
    .query(`INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
      agentId ?? 'anonymous',
      result.eventType,
      JSON.stringify(payload),
    ])
    .catch((err: unknown) => {
      log.warn('permission shadow event write failed', {
        method,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * Methods that MUST appear in METHOD_ACTION_CLASS for the contract test:
 * every RPC_METHODS value plus dispatch-only extras.
 */
export function expectedClassifiedMethods(): string[] {
  const fromProtocol = Object.values(RPC_METHODS) as string[];
  // identity.rotate is in RPC_METHODS; permission.* are future.
  const extras = ['permission.pending', 'permission.decide', 'permission.setMode'];
  return [...new Set([...fromProtocol, ...extras])].sort();
}

/** True when the gate only observes (would_*) and never blocks. */
export function isShadowOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolvePermissionMode(env) === 'shadow';
}

export type EnforceDecision =
  | { action: 'allow'; reason: 'routine' | 'auto_consequential' | 'consumed_approval' }
  | { action: 'require_approval'; reason: 'manual' | 'auto_critical' | 'auto_other' }
  | { action: 'deny'; reason: 'deny_list' };

/**
 * Live policy for manual/auto (Phase 1). Agent-scoped falls back to manual
 * until grants ship (spec §9 deferred).
 */
export function decideEnforcement(
  method: string,
  mode: PermissionMode,
  env: NodeJS.ProcessEnv = process.env,
): EnforceDecision {
  const actionClass = classifyMethod(method);
  const effective: PermissionMode =
    mode === 'agent-scoped' ? 'manual' : mode === 'shadow' ? 'shadow' : mode;

  if (effective === 'shadow') {
    return { action: 'allow', reason: 'routine' };
  }

  // Deny-list (auto + manual): comma-separated method names in env.
  const denyRaw = (env.REVDEV_PERMISSION_DENY_METHODS ?? '').trim();
  if (denyRaw.length > 0) {
    const deny = new Set(
      denyRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (deny.has(method)) {
      return { action: 'deny', reason: 'deny_list' };
    }
  }

  if (effective === 'auto') {
    if (actionClass === 'critical') {
      return { action: 'require_approval', reason: 'auto_critical' };
    }
    if (actionClass === 'consequential') {
      // Handler-side requireRoot is the real root check; auto allows here.
      return { action: 'allow', reason: 'auto_consequential' };
    }
    return { action: 'allow', reason: 'routine' };
  }

  // manual
  if (actionClass === 'routine') {
    return { action: 'allow', reason: 'routine' };
  }
  return { action: 'require_approval', reason: 'manual' };
}

export function summarizeParams(
  method: string,
  params: Record<string, unknown> | undefined,
): string {
  if (!params) return method;
  const pathish =
    (typeof params.filePath === 'string' && params.filePath) ||
    (typeof params.repoPath === 'string' && params.repoPath) ||
    (typeof params.command === 'string' && params.command) ||
    '';
  const branch =
    (typeof params.branch === 'string' && params.branch) ||
    (typeof params.name === 'string' && params.name) ||
    '';
  const bits = [method];
  if (pathish) bits.push(pathish.slice(0, 120));
  if (branch) bits.push(branch.slice(0, 64));
  return bits.join(' ').slice(0, 240);
}

export class ApprovalRequiredError extends Error {
  readonly code = APPROVAL_REQUIRED_CODE;
  readonly data: {
    kind: 'approval-required';
    approvalId: string;
    method: string;
    expiresAt: string;
  };
  constructor(approvalId: string, method: string, expiresAt: Date) {
    super(`Approval required for ${method}`);
    this.name = 'ApprovalRequiredError';
    this.data = {
      kind: 'approval-required',
      approvalId,
      method,
      expiresAt: expiresAt.toISOString(),
    };
  }
}

/**
 * Try to consume a matching approved row. Returns true if consumed (caller may proceed).
 */
export async function tryConsumeApproval(
  db: PGlite,
  agentId: string,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<boolean> {
  const paramsHash = hashParams(method, params ?? {});
  const found = await db.query<{ id: string }>(
    `SELECT id FROM pending_approvals
     WHERE agent_id = $1 AND method = $2 AND params_hash = $3
       AND status = 'approved' AND expires_at > NOW()
     ORDER BY decided_at DESC NULLS LAST
     LIMIT 1`,
    [agentId, method, paramsHash],
  );
  const row = found.rows[0];
  if (!row) return false;
  const updated = await db.query(
    `UPDATE pending_approvals SET status = 'consumed'
     WHERE id = $1 AND status = 'approved'`,
    [row.id],
  );
  // PGlite may not expose rowCount; re-check.
  const check = await db.query<{ status: string }>(
    `SELECT status FROM pending_approvals WHERE id = $1`,
    [row.id],
  );
  if (check.rows[0]?.status !== 'consumed') return false;
  void db.query(`INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
    agentId,
    'permission.consumed',
    JSON.stringify({ approvalId: row.id, method, paramsHash }),
  ]);
  void updated;
  return true;
}

/**
 * Queue a pending approval (or refuse if at flood cap). Throws ApprovalRequiredError.
 */
export async function queueApprovalRequired(
  db: PGlite,
  agentId: string,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<never> {
  const pendingCount = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM pending_approvals
     WHERE agent_id = $1 AND status = 'pending' AND expires_at > NOW()`,
    [agentId],
  );
  const n = Number(pendingCount.rows[0]?.n ?? '0');
  if (n >= MAX_PENDING_PER_AGENT) {
    throw new ApprovalRequiredError('flood-cap', method, new Date(Date.now() + PENDING_TTL_MS));
  }

  const id = randomUUID();
  const paramsHash = hashParams(method, params ?? {});
  const summary = summarizeParams(method, params);
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS);

  await db.query(
    `INSERT INTO pending_approvals (id, agent_id, method, params_hash, summary, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
    [id, agentId, method, paramsHash, summary, expiresAt.toISOString()],
  );

  // Mark session blocked (best-effort; self-scoped activity).
  await db.query(
    `UPDATE agent_sessions
     SET activity_state = 'blocked', blocked_reason = 'permission', blocked_since = NOW(), updated_at = NOW()
     WHERE id = $1 AND ended_at IS NULL`,
    [agentId],
  );

  void db.query(`INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
    agentId,
    'permission.requested',
    JSON.stringify({ approvalId: id, method, paramsHash, summary }),
  ]);

  throw new ApprovalRequiredError(id, method, expiresAt);
}

export async function listPendingApprovals(
  db: PGlite,
  agentIdFilter?: string | null,
): Promise<
  Array<{
    id: string;
    agentId: string;
    method: string;
    paramsHash: string;
    summary: string;
    requestedAt: string;
    expiresAt: string;
    status: string;
  }>
> {
  // Expire stale pending rows opportunistically.
  await db.query(
    `UPDATE pending_approvals SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= NOW()`,
  );

  const sql = agentIdFilter
    ? `SELECT id, agent_id, method, params_hash, summary, requested_at, expires_at, status
       FROM pending_approvals
       WHERE status = 'pending' AND expires_at > NOW() AND agent_id = $1
       ORDER BY requested_at ASC`
    : `SELECT id, agent_id, method, params_hash, summary, requested_at, expires_at, status
       FROM pending_approvals
       WHERE status = 'pending' AND expires_at > NOW()
       ORDER BY requested_at ASC`;
  const r = await db.query<{
    id: string;
    agent_id: string;
    method: string;
    params_hash: string;
    summary: string;
    requested_at: string;
    expires_at: string;
    status: string;
  }>(sql, agentIdFilter ? [agentIdFilter] : []);

  return r.rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    method: row.method,
    paramsHash: row.params_hash,
    summary: row.summary,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    status: row.status,
  }));
}

export async function decideApproval(
  db: PGlite,
  approvalId: string,
  verdict: 'approved' | 'denied',
  deciderAgentId: string,
): Promise<{ id: string; status: string }> {
  const row = await db.query<{
    id: string;
    agent_id: string;
    method: string;
    status: string;
  }>(`SELECT id, agent_id, method, status FROM pending_approvals WHERE id = $1`, [approvalId]);
  const found = row.rows[0];
  if (!found) {
    throw new Error(`permission.decide: unknown approvalId ${approvalId}`);
  }
  if (found.status !== 'pending') {
    throw new Error(`permission.decide: approval ${approvalId} is ${found.status}, not pending`);
  }
  // I4: self-decision structurally impossible.
  if (deciderAgentId === found.agent_id) {
    throw new Error('permission.decide: self-approval is not allowed');
  }

  const consumeExpires = new Date(Date.now() + APPROVAL_CONSUME_TTL_MS);
  const status = verdict === 'approved' ? 'approved' : 'denied';
  await db.query(
    `UPDATE pending_approvals
     SET status = $2, decided_by = $3, decided_at = NOW(),
         expires_at = CASE WHEN $2 = 'approved' THEN $4 ELSE expires_at END
     WHERE id = $1`,
    [approvalId, status, deciderAgentId, consumeExpires.toISOString()],
  );

  // Clear blocked state on requester when decided.
  await db.query(
    `UPDATE agent_sessions
     SET activity_state = 'active', blocked_reason = NULL, blocked_since = NULL, updated_at = NOW()
     WHERE id = $1 AND activity_state = 'blocked' AND blocked_reason = 'permission'`,
    [found.agent_id],
  );

  void db.query(`INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
    found.agent_id,
    verdict === 'approved' ? 'permission.approved' : 'permission.denied',
    JSON.stringify({ approvalId, method: found.method, decidedBy: deciderAgentId }),
  ]);

  return { id: approvalId, status };
}
