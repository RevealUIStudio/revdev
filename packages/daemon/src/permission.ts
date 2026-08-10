/**
 * Permission modes — action-class map + shadow/enforce gate (GAP-294).
 *
 * Spec: `.jv` docs/gap-specs/GAP-294-permission-modes-design.md §5–§10.
 *
 * Phase 0: classify + `permission.would_*` events (never blocks when mode=shadow).
 * Phase 1: manual/auto enforcement with pending_approvals + -32004 reject-with-receipt.
 * Phase agent-grants (§9): operator-issued scope grants for agent-scoped mode.
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
  ['session.snapshot.write', 'routine'],
  ['session.snapshot.get', 'routine'],
  ['session.snapshot.prune', 'routine'],
  ['session.update', 'routine'],
  ['mail.send', 'routine'],
  ['mail.broadcast', 'routine'],
  ['mail.inbox', 'routine'],
  ['mail.markRead', 'routine'],
  ['files.reserve', 'routine'],
  ['files.check', 'routine'],
  ['files.release', 'routine'],
  ['files.list', 'routine'],
  // GAP-323 design-pack watch (advisory; routine)
  ['design.pack.status', 'routine'],
  ['design.pack.watch', 'routine'],
  ['design.pack.unwatch', 'routine'],
  ['design.pack.scan', 'routine'],
  ['tasks.create', 'routine'],
  ['tasks.claim', 'routine'],
  ['tasks.complete', 'routine'],
  ['tasks.release', 'routine'],
  ['tasks.list', 'routine'],
  ['goal.create', 'routine'],
  ['goal.get', 'routine'],
  ['goal.list', 'routine'],
  ['goal.setStatus', 'routine'],
  ['goal.addCriterion', 'routine'],
  ['goal.recordCriterion', 'routine'],
  ['goal.listCriteria', 'routine'],
  ['goal.progress', 'routine'],
  ['goal.nextActions', 'routine'],
  ['goal.proposeTask', 'routine'],
  ['events.log', 'routine'],
  ['events.query', 'routine'],
  ['events.wait', 'routine'],
  ['loop.arm', 'routine'],
  ['loop.tick', 'routine'],
  ['loop.status', 'routine'],
  ['loop.spend', 'routine'],
  ['loop.record_spend', 'routine'],
  ['loop.pause', 'routine'],
  ['loop.resume', 'routine'],
  ['loop.stop', 'routine'],
  ['context.snapshot', 'routine'],
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
  ['agent.streamTicket', 'routine'],
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
  // gate controls (enumeration honesty + live handlers)
  ['permission.pending', 'routine'],
  ['permission.decide', 'critical'],
  ['permission.setMode', 'critical'],
  ['permission.listGrants', 'routine'],
  ['permission.grant', 'critical'],
  ['permission.revokeGrant', 'critical'],
  // Revokes a bearer credential — reversible (a new one can be paired), so
  // consequential rather than critical (GAP-421 guardrail-2 remediation S5).
  ['gateway.revokeToken', 'consequential'],
  // GAP-154 Phase 5 — peer discovery (diagnostic; empty without Neon)
  ['daemon.peers', 'routine'],
  // GAP-474 — list is routine; run may trigger gated cleanup with fix:true
  ['workflow.list', 'routine'],
  ['workflow.run', 'consequential'],
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
  const extras = [
    'permission.pending',
    'permission.decide',
    'permission.setMode',
    'permission.listGrants',
    'permission.grant',
    'permission.revokeGrant',
  ];
  return [...new Set([...fromProtocol, ...extras])].sort();
}

/** True when the gate only observes (would_*) and never blocks. */
export function isShadowOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolvePermissionMode(env) === 'shadow';
}

export type EnforceDecision =
  | {
      action: 'allow';
      reason: 'routine' | 'auto_consequential' | 'consumed_approval' | 'agent_grant';
    }
  | {
      action: 'require_approval';
      reason: 'manual' | 'auto_critical' | 'auto_other' | 'agent_scoped';
    }
  | { action: 'deny'; reason: 'deny_list' };

/**
 * Live policy for manual / auto / agent-scoped (spec §4 + §9).
 *
 * Agent-scoped: routine allows; consequential/critical return require_approval
 * so the gate can try matching an operator grant before queueing (§9).
 * Critical coverage requires an explicit method name on the grant (never class).
 */
export function decideEnforcement(
  method: string,
  mode: PermissionMode,
  env: NodeJS.ProcessEnv = process.env,
): EnforceDecision {
  const actionClass = classifyMethod(method);
  const effective: PermissionMode = mode === 'shadow' ? 'shadow' : mode;

  if (effective === 'shadow') {
    return { action: 'allow', reason: 'routine' };
  }

  // Deny-list (all enforce modes): comma-separated method names in env.
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

  if (effective === 'agent-scoped') {
    if (actionClass === 'routine') {
      return { action: 'allow', reason: 'routine' };
    }
    // Caller consults permission_grants; unmatched → manual-style queue.
    return { action: 'require_approval', reason: 'agent_scoped' };
  }

  // manual
  if (actionClass === 'routine') {
    return { action: 'allow', reason: 'routine' };
  }
  return { action: 'require_approval', reason: 'manual' };
}

/** Grant may name these action classes (critical never by class — methods only). */
export const GRANTABLE_CLASSES = ['consequential'] as const;
export type GrantableClass = (typeof GRANTABLE_CLASSES)[number];

/** Default grant TTL when operator omits expiresAt (24h). */
export const GRANT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface PermissionGrantRow {
  id: string;
  granteeAgentId: string;
  classes: string[];
  methods: string[];
  rootScope: string | null;
  expiresAt: string;
  maxUses: number | null;
  usesRemaining: number | null;
  issuedBy: string;
  issuedAt: string;
  revokedAt: string | null;
  status: string;
}

function parseJsonStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string');
  }
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string');
      }
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Whether a grant covers this method for the given action class (spec §9).
 * - critical: only if methods[] names the method (never by class)
 * - consequential: classes includes 'consequential' OR methods names the method
 * - routine: always covered without a grant (not called for routine)
 */
export function grantCoversMethod(
  grant: { classes: string[]; methods: string[] },
  method: string,
  actionClass: ActionClass,
): boolean {
  if (actionClass === 'critical') {
    return grant.methods.includes(method);
  }
  if (actionClass === 'consequential') {
    return grant.classes.includes('consequential') || grant.methods.includes(method);
  }
  return true;
}

/**
 * Optional root_scope prefix check when the call params carry a path.
 * If the grant has no root_scope, or params have no pathish field, match is ok
 * (confinement / requireRoot remain senior — I3).
 */
export function grantRootMatches(
  rootScope: string | null | undefined,
  params: Record<string, unknown> | undefined,
): boolean {
  if (!rootScope) return true;
  if (!params) return true;
  const pathish =
    (typeof params.filePath === 'string' && params.filePath) ||
    (typeof params.repoPath === 'string' && params.repoPath) ||
    (typeof params.path === 'string' && params.path) ||
    (typeof params.cwd === 'string' && params.cwd) ||
    '';
  if (!pathish) return true;
  const root = rootScope.endsWith('/') ? rootScope : `${rootScope}/`;
  return pathish === rootScope || pathish.startsWith(root);
}

/**
 * Find an active grant covering (agent, method), optionally consume one use.
 * Returns grant id when allowed; null when no grant covers the call.
 */
export async function tryConsumeGrant(
  db: PGlite,
  granteeAgentId: string,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<{ grantId: string } | null> {
  const actionClass = classifyMethod(method);

  // Expire stale active grants opportunistically.
  await db.query(
    `UPDATE permission_grants SET status = 'expired'
     WHERE status = 'active' AND expires_at <= NOW()`,
  );

  const r = await db.query<{
    id: string;
    classes: unknown;
    methods: unknown;
    root_scope: string | null;
    uses_remaining: number | null;
  }>(
    `SELECT id, classes, methods, root_scope, uses_remaining
     FROM permission_grants
     WHERE grantee_agent_id = $1 AND status = 'active' AND expires_at > NOW()
       AND (uses_remaining IS NULL OR uses_remaining > 0)
     ORDER BY issued_at ASC`,
    [granteeAgentId],
  );

  for (const row of r.rows) {
    const classes = parseJsonStringArray(row.classes);
    const methods = parseJsonStringArray(row.methods);
    if (!grantCoversMethod({ classes, methods }, method, actionClass)) continue;
    if (!grantRootMatches(row.root_scope, params)) continue;

    if (row.uses_remaining !== null && row.uses_remaining !== undefined) {
      const updated = await db.query<{ uses_remaining: number }>(
        `UPDATE permission_grants
         SET uses_remaining = uses_remaining - 1,
             status = CASE WHEN uses_remaining - 1 <= 0 THEN 'exhausted' ELSE status END
         WHERE id = $1 AND status = 'active' AND uses_remaining > 0
         RETURNING uses_remaining`,
        [row.id],
      );
      if (!updated.rows[0]) continue;
    }

    void db.query(`INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
      granteeAgentId,
      'permission.grant_allowed',
      JSON.stringify({
        grantId: row.id,
        method,
        actionClass,
      }),
    ]);

    return { grantId: row.id };
  }

  return null;
}

export interface IssueGrantInput {
  granteeAgentId: string;
  classes?: string[];
  methods?: string[];
  rootScope?: string | null;
  expiresAt?: string | Date | null;
  maxUses?: number | null;
  issuedBy: string;
}

/**
 * Operator-issued scope grant (spec §9). At least one of classes or methods
 * required. Critical methods may only appear in methods[] (never as a class).
 */
export async function issueGrant(db: PGlite, input: IssueGrantInput): Promise<PermissionGrantRow> {
  const grantee = input.granteeAgentId?.trim();
  if (!grantee) {
    throw new Error('permission.grant: granteeAgentId is required');
  }
  if (input.issuedBy === grantee) {
    throw new Error('permission.grant: an agent cannot issue a grant to itself');
  }

  const classes = (input.classes ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  const methods = (input.methods ?? []).map((m) => m.trim()).filter(Boolean);

  for (const c of classes) {
    if (c === 'critical') {
      throw new Error(
        'permission.grant: critical cannot be granted by class; name methods explicitly',
      );
    }
    if (c === 'routine') {
      throw new Error('permission.grant: routine needs no grant');
    }
    if (!(GRANTABLE_CLASSES as readonly string[]).includes(c)) {
      throw new Error(`permission.grant: unknown class '${c}' (allowed: consequential)`);
    }
  }
  if (classes.length === 0 && methods.length === 0) {
    throw new Error('permission.grant: provide classes and/or methods');
  }

  let maxUses: number | null = null;
  if (input.maxUses !== null && input.maxUses !== undefined) {
    if (!Number.isInteger(input.maxUses) || input.maxUses < 1) {
      throw new Error('permission.grant: maxUses must be a positive integer when set');
    }
    maxUses = input.maxUses;
  }

  let expiresAt: Date;
  if (input.expiresAt) {
    expiresAt = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new Error('permission.grant: expiresAt is not a valid date');
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw new Error('permission.grant: expiresAt must be in the future');
    }
  } else {
    expiresAt = new Date(Date.now() + GRANT_DEFAULT_TTL_MS);
  }

  const id = randomUUID();
  const rootScope =
    typeof input.rootScope === 'string' && input.rootScope.trim() ? input.rootScope.trim() : null;

  await db.query(
    `INSERT INTO permission_grants (
       id, grantee_agent_id, classes, methods, root_scope,
       expires_at, max_uses, uses_remaining, issued_by, status
     ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, 'active')`,
    [
      id,
      grantee,
      JSON.stringify(classes),
      JSON.stringify(methods),
      rootScope,
      expiresAt.toISOString(),
      maxUses,
      maxUses,
      input.issuedBy,
    ],
  );

  void db.query(`INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
    grantee,
    'permission.grant_issued',
    JSON.stringify({
      grantId: id,
      classes,
      methods,
      rootScope,
      maxUses,
      expiresAt: expiresAt.toISOString(),
      issuedBy: input.issuedBy,
    }),
  ]);

  return {
    id,
    granteeAgentId: grantee,
    classes,
    methods,
    rootScope,
    expiresAt: expiresAt.toISOString(),
    maxUses,
    usesRemaining: maxUses,
    issuedBy: input.issuedBy,
    issuedAt: new Date().toISOString(),
    revokedAt: null,
    status: 'active',
  };
}

export async function listGrants(
  db: PGlite,
  granteeFilter?: string | null,
  includeInactive = false,
): Promise<PermissionGrantRow[]> {
  await db.query(
    `UPDATE permission_grants SET status = 'expired'
     WHERE status = 'active' AND expires_at <= NOW()`,
  );

  const statusClause = includeInactive ? '' : ` AND status = 'active' AND expires_at > NOW()`;
  const sql = granteeFilter
    ? `SELECT id, grantee_agent_id, classes, methods, root_scope, expires_at,
              max_uses, uses_remaining, issued_by, issued_at, revoked_at, status
       FROM permission_grants
       WHERE grantee_agent_id = $1${statusClause}
       ORDER BY issued_at DESC`
    : `SELECT id, grantee_agent_id, classes, methods, root_scope, expires_at,
              max_uses, uses_remaining, issued_by, issued_at, revoked_at, status
       FROM permission_grants
       WHERE 1=1${statusClause}
       ORDER BY issued_at DESC`;

  const r = await db.query<{
    id: string;
    grantee_agent_id: string;
    classes: unknown;
    methods: unknown;
    root_scope: string | null;
    expires_at: string;
    max_uses: number | null;
    uses_remaining: number | null;
    issued_by: string;
    issued_at: string;
    revoked_at: string | null;
    status: string;
  }>(sql, granteeFilter ? [granteeFilter] : []);

  return r.rows.map((row) => ({
    id: row.id,
    granteeAgentId: row.grantee_agent_id,
    classes: parseJsonStringArray(row.classes),
    methods: parseJsonStringArray(row.methods),
    rootScope: row.root_scope,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    usesRemaining: row.uses_remaining,
    issuedBy: row.issued_by,
    issuedAt: row.issued_at,
    revokedAt: row.revoked_at,
    status: row.status,
  }));
}

export async function revokeGrant(
  db: PGlite,
  grantId: string,
  operatorAgentId: string,
): Promise<{ id: string; status: string }> {
  if (!grantId?.trim()) {
    throw new Error('permission.revokeGrant: grantId is required');
  }

  const found = await db.query<{
    id: string;
    grantee_agent_id: string;
    status: string;
  }>(`SELECT id, grantee_agent_id, status FROM permission_grants WHERE id = $1`, [grantId]);
  const row = found.rows[0];
  if (!row) {
    throw new Error(`permission.revokeGrant: unknown grantId ${grantId}`);
  }
  if (row.status !== 'active') {
    throw new Error(`permission.revokeGrant: grant ${grantId} is ${row.status}, not active`);
  }

  await db.query(
    `UPDATE permission_grants
     SET status = 'revoked', revoked_at = NOW()
     WHERE id = $1 AND status = 'active'`,
    [grantId],
  );

  void db.query(`INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
    row.grantee_agent_id,
    'permission.grant_revoked',
    JSON.stringify({ grantId, revokedBy: operatorAgentId }),
  ]);

  return { id: grantId, status: 'revoked' };
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

/** Per-session overrides (migration 0007). Daemon default still from env. */
export const SESSION_PERMISSION_MODES = ['manual', 'auto', 'agent-scoped', 'shadow'] as const;
export type SessionPermissionMode = (typeof SESSION_PERMISSION_MODES)[number];

export function parseSessionPermissionMode(raw: unknown): SessionPermissionMode | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') return null;
  const m = raw.trim().toLowerCase();
  if ((SESSION_PERMISSION_MODES as readonly string[]).includes(m)) {
    return m as SessionPermissionMode;
  }
  return null;
}

/**
 * Effective mode for a call: session `permission_mode` override, else daemon default.
 * Spec §3: effective = per-session override ?? daemon default.
 */
export async function resolveEffectiveMode(
  db: PGlite,
  agentId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PermissionMode> {
  const daemonDefault = resolvePermissionMode(env);
  if (!agentId) return daemonDefault;
  const r = await db.query<{ permission_mode: string | null }>(
    `SELECT permission_mode FROM agent_sessions WHERE id = $1 AND ended_at IS NULL`,
    [agentId],
  );
  const override = parseSessionPermissionMode(r.rows[0]?.permission_mode);
  return override ?? daemonDefault;
}

/**
 * Operator-only per-session mode override (GAP-294 Phase 2).
 * A session can never set its own mode (self-defeat).
 */
export async function setSessionPermissionMode(
  db: PGlite,
  targetAgentId: string,
  mode: SessionPermissionMode | null,
  operatorAgentId: string,
): Promise<{ agentId: string; permissionMode: SessionPermissionMode | null }> {
  if (!targetAgentId) {
    throw new Error('permission.setMode: agentId is required');
  }
  if (operatorAgentId === targetAgentId) {
    throw new Error('permission.setMode: a session cannot set its own mode');
  }

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM agent_sessions WHERE id = $1 AND ended_at IS NULL`,
    [targetAgentId],
  );
  if (!existing.rows[0]) {
    throw new Error(`permission.setMode: no live session for agentId ${targetAgentId}`);
  }

  await db.query(
    `UPDATE agent_sessions
     SET permission_mode = $2, updated_at = NOW()
     WHERE id = $1 AND ended_at IS NULL`,
    [targetAgentId, mode],
  );

  void db.query(`INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
    targetAgentId,
    'permission.mode_set',
    JSON.stringify({
      permissionMode: mode,
      setBy: operatorAgentId,
    }),
  ]);

  return { agentId: targetAgentId, permissionMode: mode };
}
