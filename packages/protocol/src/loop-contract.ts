/**
 * Studio daemon LoopGuard wire contract (GAP-362).
 *
 * Product runtimes call these methods only when Studio-attached (the harness
 * socket is reachable). A non-Studio path must not require the daemon.
 *
 * Transport: JSON-RPC 2.0, one frame per line, on the harness socket
 * (default `~/.local/share/revealui/harness.sock`). The same methods are
 * accepted on the optional HTTP gateway `POST /rpc` when that gateway is on.
 *
 * Required trio:
 *   loop.arm     register a loop on the caller's live session
 *   loop.tick    report one iteration (always counted; never a dropped tick)
 *   loop.status  read the loop, or `{ loop: null }` when it is gone
 *
 * Default noop limit is `DEFAULT_LOOP_NOOP_LIMIT` (3). Omit `noopLimit` on
 * arm and the daemon applies 3. After that many consecutive `advanced: false`
 * ticks, `status` is `not_advancing` and `stop` is true. The caller stops.
 * An advancing tick clears the counter. An unknown `loopId` on tick is an
 * error, not an empty success.
 *
 * Session binding: `loop.arm` attaches the loop to the caller's session
 * (session id is the agent id). `session.end` and `harness.prune` reap those
 * loops. A later tick fails with unknown loopId. There is no leftover guard.
 *
 * Identity: same routine gate as other coordination calls. A daemon-minted
 * session may pass `actorAgentId`. A client-owned identity must sign the
 * frame (`x-revdev-signature`). Unsigned client-owned calls are rejected.
 *
 * Sibling methods (same `loopId`, not required for the product runtime):
 *   loop.pause, loop.resume, loop.stop, loop.spend, loop.record_spend
 */

import { RPC_METHODS } from './methods.js';
import type { DaemonRpc } from './wait-for-work.js';

/** Conventional harness socket path. Override with `REVDEV_DAEMON_SOCKET`. */
export const HARNESS_SOCK_DEFAULT = '~/.local/share/revealui/harness.sock';

/**
 * Consecutive `advanced: false` ticks before `not_advancing`.
 * Applied when `loop.arm` omits `noopLimit`.
 */
export const DEFAULT_LOOP_NOOP_LIMIT = 3;

export const LOOP_GUARD_METHODS = {
  arm: RPC_METHODS['loop.arm'],
  tick: RPC_METHODS['loop.tick'],
  status: RPC_METHODS['loop.status'],
  spend: RPC_METHODS['loop.spend'],
  recordSpend: RPC_METHODS['loop.record_spend'],
  pause: RPC_METHODS['loop.pause'],
  resume: RPC_METHODS['loop.resume'],
  stop: RPC_METHODS['loop.stop'],
} as const;

export type LoopGuardStatus = 'armed' | 'paused' | 'stopped' | 'not_advancing';

export interface LoopSpendWire {
  /** Provider input tokens attributed to this loop. */
  tokensIn: number;
  /** Provider output tokens attributed to this loop. */
  tokensOut: number;
  /** Optional micro-USD cost (integer micros; 1 USD = 1_000_000). */
  costMicros: number;
}

/** Loop object returned by arm, tick, and status. */
export interface LoopGuardWireState {
  loopId: string;
  agentId: string;
  /**
   * Session this loop is attached to. RPC arms set this to the agent id.
   * Null only for an in-process arm that omitted it.
   */
  sessionId: string | null;
  /** Declared wait interval (ms). Under 60_000 sets cadenceWarning. */
  intervalMs: number;
  consecutiveNoOps: number;
  /** Limit in force. Default 3 when arm omitted noopLimit. */
  noopLimit: number;
  status: LoopGuardStatus;
  cadenceWarning: string | null;
  tickCount: number;
  createdAt: number;
  updatedAt: number;
  lastSignal: string | null;
  spend: LoopSpendWire;
}

export interface LoopActorParams {
  /**
   * Daemon-minted callers may pass this. Client-owned identities must sign
   * the frame instead.
   */
  actorAgentId?: string;
}

export interface LoopArmParams extends LoopActorParams {
  loopId: string;
  /** Positive cadence in ms, max 86_400_000. */
  intervalMs: number;
  /**
   * Consecutive advanced:false ticks before not_advancing.
   * Omit to apply DEFAULT_LOOP_NOOP_LIMIT (3). Integer 1..100 when set.
   */
  noopLimit?: number;
  /**
   * Session to reap with. Omit to bind the caller's own session.
   * Must be the caller's agent id when set.
   */
  sessionId?: string;
}

export interface LoopTickParams extends LoopActorParams {
  loopId: string;
  /**
   * Required boolean. true resets the no-op streak. false counts toward
   * noopLimit. Missing or non-boolean is an error, not a silent no-op.
   */
  advanced: boolean;
  /** Optional spend delta for this tick. */
  tokensIn?: number;
  tokensOut?: number;
  costMicros?: number;
}

export interface LoopStatusParams extends LoopActorParams {
  loopId: string;
}

export interface LoopArmWireResult {
  loop: LoopGuardWireState;
  /** True only when a re-arm lands on an already not_advancing loop. */
  stop: boolean;
  /** Limit actually applied (echo of loop.noopLimit). */
  noopLimit: number;
}

export interface LoopTickWireResult {
  loop: LoopGuardWireState;
  /** True when status is not_advancing. The caller must stop. */
  stop: boolean;
  noopLimit: number;
}

export interface LoopStatusWireResult {
  /** Null when the loop was never armed or was reaped with its session. */
  loop: LoopGuardWireState | null;
  /** True when a live loop is not_advancing. False when the loop is absent. */
  stop: boolean;
  noopLimit: number | null;
}

/** True when the caller must stop. `stopped` is already finished and is false. */
export function loopMustStop(status: string | null | undefined): boolean {
  return status === 'not_advancing';
}

function readAppliedLoop(raw: Record<string, unknown>, method: string): LoopGuardWireState {
  const loop = raw.loop;
  if (!loop || typeof loop !== 'object') {
    throw new Error(`${method} returned no loop; the call was not applied`);
  }
  const state = loop as LoopGuardWireState;
  if (typeof state.tickCount !== 'number' || typeof state.noopLimit !== 'number') {
    throw new Error(`${method} returned an incomplete loop; the call was not applied`);
  }
  if (typeof state.status !== 'string') {
    throw new Error(`${method} returned no status; the call was not applied`);
  }
  return state;
}

/**
 * Arm a session-attached loop. When `noopLimit` is omitted, the applied
 * limit must be DEFAULT_LOOP_NOOP_LIMIT. A response that drops the loop
 * object is an error.
 */
export async function armDaemonLoop(
  rpc: DaemonRpc,
  params: LoopArmParams,
): Promise<LoopArmWireResult> {
  if (typeof params.loopId !== 'string' || params.loopId.length === 0) {
    throw new Error('loop.arm requires loopId');
  }
  if (typeof params.intervalMs !== 'number' || !(params.intervalMs > 0)) {
    throw new Error('loop.arm requires a positive intervalMs');
  }
  const body: Record<string, unknown> = {
    loopId: params.loopId,
    intervalMs: params.intervalMs,
  };
  if (params.noopLimit !== undefined) body.noopLimit = params.noopLimit;
  if (params.sessionId !== undefined) body.sessionId = params.sessionId;
  if (params.actorAgentId !== undefined) body.actorAgentId = params.actorAgentId;
  const raw = await rpc(LOOP_GUARD_METHODS.arm, body);
  const loop = readAppliedLoop(raw, LOOP_GUARD_METHODS.arm);
  if (params.noopLimit === undefined && loop.noopLimit !== DEFAULT_LOOP_NOOP_LIMIT) {
    throw new Error(
      `loop.arm omitted noopLimit but daemon applied ${loop.noopLimit}, expected ${DEFAULT_LOOP_NOOP_LIMIT}`,
    );
  }
  const stop = raw.stop === true || loopMustStop(loop.status);
  return { loop, stop, noopLimit: loop.noopLimit };
}

/**
 * Report one iteration. `advanced` must be a boolean so a tick cannot be
 * ignored or coerced. The result always carries the loop and a stop flag.
 */
export async function tickDaemonLoop(
  rpc: DaemonRpc,
  params: LoopTickParams,
): Promise<LoopTickWireResult> {
  if (typeof params.advanced !== 'boolean') {
    throw new Error('loop.tick requires advanced: boolean; ticks are never ignored');
  }
  if (typeof params.loopId !== 'string' || params.loopId.length === 0) {
    throw new Error('loop.tick requires loopId');
  }
  const body: Record<string, unknown> = {
    loopId: params.loopId,
    advanced: params.advanced,
  };
  if (params.tokensIn !== undefined) body.tokensIn = params.tokensIn;
  if (params.tokensOut !== undefined) body.tokensOut = params.tokensOut;
  if (params.costMicros !== undefined) body.costMicros = params.costMicros;
  if (params.actorAgentId !== undefined) body.actorAgentId = params.actorAgentId;
  const raw = await rpc(LOOP_GUARD_METHODS.tick, body);
  const loop = readAppliedLoop(raw, LOOP_GUARD_METHODS.tick);
  const stop = raw.stop === true || loopMustStop(loop.status);
  return { loop, stop, noopLimit: loop.noopLimit };
}

/** Read a loop. A missing loop is `{ loop: null, stop: false }`, not an error. */
export async function statusDaemonLoop(
  rpc: DaemonRpc,
  params: LoopStatusParams,
): Promise<LoopStatusWireResult> {
  if (typeof params.loopId !== 'string' || params.loopId.length === 0) {
    throw new Error('loop.status requires loopId');
  }
  const body: Record<string, unknown> = { loopId: params.loopId };
  if (params.actorAgentId !== undefined) body.actorAgentId = params.actorAgentId;
  const raw = await rpc(LOOP_GUARD_METHODS.status, body);
  if (raw.loop == null) {
    return { loop: null, stop: false, noopLimit: null };
  }
  const loop = readAppliedLoop(raw, LOOP_GUARD_METHODS.status);
  const stop = raw.stop === true || loopMustStop(loop.status);
  return { loop, stop, noopLimit: loop.noopLimit };
}
