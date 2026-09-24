/**
 * GAP-362: loop cadence + stop-when-not-advancing (token-economy).
 *
 * Process-local tracker. It does not schedule work. Callers arm a loop id,
 * report ticks with whether work advanced, and get not_advancing when
 * consecutive no-ops hit the cap (default 3, from the protocol contract).
 * Sub-minute idle intervals only WARN (never hard-block) so operators can
 * still use short cadences when matched to a real signal.
 *
 * Every tick counts. A missing loop throws. A non-boolean `advanced` throws.
 * Re-arming a live loop does not clear the no-op streak.
 *
 * Session-attached loops are removed by reapAgent, which the session-end
 * hook runs for session.end and harness.prune. Reaped ids are gone: a later
 * tick is an unknown-loop error, not a leftover guard.
 */

import { DEFAULT_LOOP_NOOP_LIMIT, loopMustStop } from '@revdev/protocol';
import { onAgentEnded } from './eviction.js';

export const DEFAULT_NOOP_LIMIT = DEFAULT_LOOP_NOOP_LIMIT;
/** Idle intervals below this get a cadence warning (ms). */
export const MIN_IDLE_INTERVAL_MS = 60_000;

export type LoopStatus = 'armed' | 'paused' | 'stopped' | 'not_advancing';

/** Cumulative spend for a loop (process-local; also mirrored on loop.tick events). */
export interface LoopSpend {
  /** Provider input tokens attributed to this loop. */
  tokensIn: number;
  /** Provider output tokens attributed to this loop. */
  tokensOut: number;
  /** Optional micro-USD cost (integer micros; 1 USD = 1_000_000). */
  costMicros: number;
}

export interface LoopState {
  loopId: string;
  agentId: string;
  /**
   * Session this loop is attached to. Reaped when that session ends.
   * Null when the caller did not attach one (in-process only).
   * RPC arms always set this to the agent id.
   */
  sessionId: string | null;
  /** Declared wait interval (ms). Used only for cadence warn. */
  intervalMs: number;
  consecutiveNoOps: number;
  noopLimit: number;
  status: LoopStatus;
  cadenceWarning: string | null;
  tickCount: number;
  createdAt: number;
  updatedAt: number;
  lastSignal: string | null;
  /** Per-loop spend (GAP-362 residual: queryable via loop.status / loop.spend). */
  spend: LoopSpend;
}

export interface ArmLoopInput {
  loopId: string;
  agentId: string;
  intervalMs: number;
  noopLimit?: number;
  /** Attach to this session. Reaped when the session (or this id) ends. */
  sessionId?: string | null;
  now?: number;
}

export interface TickLoopInput {
  loopId: string;
  /** True when this iteration advanced work (new output, task progress, etc.). */
  advanced: boolean;
  /** Optional spend delta for this tick (token-economy metering). */
  tokensIn?: number;
  tokensOut?: number;
  costMicros?: number;
  now?: number;
}

export interface RecordSpendInput {
  loopId: string;
  tokensIn?: number;
  tokensOut?: number;
  costMicros?: number;
  now?: number;
}

/** Wire envelope for loop.arm / loop.tick / loop.status. */
export interface LoopRpcView {
  loop: LoopState | null;
  /** True when the caller must stop (status is not_advancing). */
  stop: boolean;
  /** Limit in force, or null when the loop is absent. */
  noopLimit: number | null;
}

function nonNegInt(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function normalizeNoopLimit(noopLimit: number | undefined): number {
  if (typeof noopLimit === 'number' && Number.isFinite(noopLimit) && noopLimit > 0) {
    return Math.floor(noopLimit);
  }
  return DEFAULT_NOOP_LIMIT;
}

function cleanSessionId(sessionId: string | null | undefined): string | null {
  if (typeof sessionId !== 'string') return null;
  const trimmed = sessionId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function notAdvancingSignal(consecutiveNoOps: number, noopLimit: number): string {
  return (
    `loop not advancing: ${consecutiveNoOps} consecutive no-ops ` +
    `(limit ${noopLimit}); stop or widen`
  );
}

export function cadenceWarningForInterval(intervalMs: number): string | null {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return 'intervalMs must be a positive number';
  }
  if (intervalMs < MIN_IDLE_INTERVAL_MS) {
    return (
      `intervalMs ${intervalMs} is under ${MIN_IDLE_INTERVAL_MS}ms: prefer matching ` +
      `cadence to the signal (for example wait on work.completed) instead of sub-minute idle polls`
    );
  }
  return null;
}

export function loopRpcView(state: LoopState | null): LoopRpcView {
  if (!state) return { loop: null, stop: false, noopLimit: null };
  return {
    loop: state,
    stop: loopMustStop(state.status),
    noopLimit: state.noopLimit,
  };
}

export class LoopGuardRegistry {
  private readonly loops = new Map<string, LoopState>();

  arm(input: ArmLoopInput): LoopState {
    const now = input.now ?? Date.now();
    const cadenceWarning = cadenceWarningForInterval(input.intervalMs);
    if (cadenceWarning === 'intervalMs must be a positive number') {
      throw new Error(cadenceWarning);
    }
    const sessionId = cleanSessionId(input.sessionId);
    const existing = this.loops.get(input.loopId);
    if (existing && existing.agentId !== input.agentId) {
      throw new Error(`loop ${input.loopId} is owned by another agent`);
    }
    // A live re-arm refreshes cadence only. It must not clear the no-op
    // streak, tick count, or spend, or a caller could dodge the limit by
    // arming again between ticks.
    if (existing && existing.status !== 'stopped') {
      existing.intervalMs = input.intervalMs;
      existing.cadenceWarning = cadenceWarning;
      existing.updatedAt = now;
      if (sessionId) existing.sessionId = sessionId;
      if (input.noopLimit !== undefined) {
        existing.noopLimit = normalizeNoopLimit(input.noopLimit);
      }
      if (existing.status !== 'paused' && existing.consecutiveNoOps >= existing.noopLimit) {
        existing.status = 'not_advancing';
        existing.lastSignal = notAdvancingSignal(existing.consecutiveNoOps, existing.noopLimit);
      }
      return this.clone(existing);
    }
    const state: LoopState = {
      loopId: input.loopId,
      agentId: input.agentId,
      sessionId,
      intervalMs: input.intervalMs,
      consecutiveNoOps: 0,
      noopLimit: normalizeNoopLimit(input.noopLimit),
      status: 'armed',
      cadenceWarning,
      tickCount: 0,
      createdAt: now,
      updatedAt: now,
      lastSignal: cadenceWarning,
      spend: { tokensIn: 0, tokensOut: 0, costMicros: 0 },
    };
    this.loops.set(input.loopId, state);
    return this.clone(state);
  }

  get(loopId: string): LoopState | null {
    const s = this.loops.get(loopId);
    return s ? this.clone(s) : null;
  }

  /** Cumulative spend for a loop (null if unknown). */
  spend(loopId: string): LoopSpend | null {
    const s = this.loops.get(loopId);
    return s ? { ...s.spend } : null;
  }

  recordSpend(input: RecordSpendInput): LoopState {
    const s = this.require(input.loopId);
    if (s.status === 'stopped') throw new Error(`loop ${input.loopId} is stopped`);
    const now = input.now ?? Date.now();
    s.spend.tokensIn += nonNegInt(input.tokensIn);
    s.spend.tokensOut += nonNegInt(input.tokensOut);
    s.spend.costMicros += nonNegInt(input.costMicros);
    s.updatedAt = now;
    return this.clone(s);
  }

  tick(input: TickLoopInput): LoopState {
    const s = this.loops.get(input.loopId);
    if (!s) throw new Error(`unknown loopId: ${input.loopId}`);
    if (s.status === 'stopped') throw new Error(`loop ${input.loopId} is stopped`);
    if (s.status === 'paused') throw new Error(`loop ${input.loopId} is paused; resume first`);
    if (typeof input.advanced !== 'boolean') {
      throw new Error('loop.tick requires advanced: boolean');
    }

    const now = input.now ?? Date.now();
    // Count before the advanced branch so a tick cannot return unchanged.
    s.tickCount += 1;
    s.updatedAt = now;
    s.spend.tokensIn += nonNegInt(input.tokensIn);
    s.spend.tokensOut += nonNegInt(input.tokensOut);
    s.spend.costMicros += nonNegInt(input.costMicros);

    if (input.advanced) {
      s.consecutiveNoOps = 0;
      s.status = 'armed';
      s.lastSignal = null;
    } else {
      s.consecutiveNoOps += 1;
      if (s.consecutiveNoOps >= s.noopLimit) {
        s.status = 'not_advancing';
        s.lastSignal = notAdvancingSignal(s.consecutiveNoOps, s.noopLimit);
      } else {
        s.lastSignal = null;
      }
    }
    return this.clone(s);
  }

  pause(loopId: string, now = Date.now()): LoopState {
    const s = this.require(loopId);
    if (s.status === 'stopped') throw new Error(`loop ${loopId} is stopped`);
    s.status = 'paused';
    s.updatedAt = now;
    s.lastSignal = 'paused';
    return this.clone(s);
  }

  resume(loopId: string, now = Date.now()): LoopState {
    const s = this.require(loopId);
    if (s.status === 'stopped') throw new Error(`loop ${loopId} is stopped`);
    s.status = 'armed';
    s.updatedAt = now;
    s.lastSignal = null;
    return this.clone(s);
  }

  stop(loopId: string, now = Date.now()): LoopState {
    const s = this.require(loopId);
    s.status = 'stopped';
    s.updatedAt = now;
    s.lastSignal = 'stopped';
    return this.clone(s);
  }

  /**
   * Drop every loop owned by this agent or attached to this session id.
   * Returned snapshots are marked stopped. The registry no longer holds them.
   */
  reapAgent(agentId: string, now = Date.now()): LoopState[] {
    const reaped: LoopState[] = [];
    for (const [id, s] of this.loops) {
      if (s.agentId !== agentId && s.sessionId !== agentId) continue;
      s.status = 'stopped';
      s.updatedAt = now;
      s.lastSignal = 'reaped with session';
      reaped.push(this.clone(s));
      this.loops.delete(id);
    }
    return reaped;
  }

  private require(loopId: string): LoopState {
    const s = this.loops.get(loopId);
    if (!s) throw new Error(`unknown loopId: ${loopId}`);
    return s;
  }

  private clone(s: LoopState): LoopState {
    return { ...s, spend: { ...s.spend } };
  }
}

/** Process-wide registry (one daemon process). */
export const loopGuards = new LoopGuardRegistry();

// session.end and harness.prune both call notifyAgentEnded. Reap here so a
// finished session cannot leave a guard that still accepts ticks.
onAgentEnded((agentId, db) => {
  const reaped = loopGuards.reapAgent(agentId);
  if (reaped.length === 0) return;
  void db
    .query(`INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)`, [
      agentId,
      'loop.reaped',
      JSON.stringify({
        loopIds: reaped.map((s) => s.loopId),
        reason: 'session_ended',
      }),
    ])
    .catch(() => {
      /* best-effort: the in-memory reap already happened */
    });
});
