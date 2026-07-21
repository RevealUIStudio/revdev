/**
 * Permission modes — action-class map + shadow gate (GAP-294 Phase 0).
 *
 * Spec: `.jv` docs/gap-specs/GAP-294-permission-modes-design.md §5 / §10.
 *
 * Phase 0 (this module): classify every RPC and emit `permission.would_*`
 * audit events. NEVER blocks. Unmapped methods fail closed to `critical`.
 *
 * Manual/auto enforcement (pending_approvals, -32004) is Phase 1+.
 */

import type { PGlite } from '@electric-sql/pglite';
import { RPC_METHODS } from '@revdev/protocol';
import { createLogger } from '@revealui/utils/logger';

const log = createLogger({ service: 'revdev-daemon/permission' });

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

/** True when the live gate must not block (Phase 0: always, or explicit shadow). */
export function isShadowOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = resolvePermissionMode(env);
  // Phase 0: even if someone sets manual/auto, we still only shadow until
  // Phase 1 enforcement ships. Hard-code true for this PR; Phase 1 flips.
  return mode === 'shadow' || mode === 'manual' || mode === 'auto' || mode === 'agent-scoped';
}
