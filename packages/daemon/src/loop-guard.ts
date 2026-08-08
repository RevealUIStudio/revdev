/**
 * GAP-362 — loop cadence + stop-when-not-advancing (token-economy).
 *
 * Pure process-local tracker. Does not schedule work itself — callers arm a
 * loop id, report ticks with whether work advanced, and get a signal when
 * consecutive no-ops hit the cap (default 3). Sub-minute idle intervals only
 * WARN (never hard-block) so operators can still use short cadences when
 * matched to a real signal.
 */

export const DEFAULT_NOOP_LIMIT = 3;
/** Idle intervals below this get a cadence warning (ms). */
export const MIN_IDLE_INTERVAL_MS = 60_000;

export type LoopStatus = 'armed' | 'paused' | 'stopped' | 'not_advancing';

export interface LoopState {
  loopId: string;
  agentId: string;
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
}

export interface ArmLoopInput {
  loopId: string;
  agentId: string;
  intervalMs: number;
  noopLimit?: number;
  now?: number;
}

export interface TickLoopInput {
  loopId: string;
  /** True when this iteration advanced work (new output, task progress, etc.). */
  advanced: boolean;
  now?: number;
}

export function cadenceWarningForInterval(intervalMs: number): string | null {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return 'intervalMs must be a positive number';
  }
  if (intervalMs < MIN_IDLE_INTERVAL_MS) {
    return (
      `intervalMs ${intervalMs} is under ${MIN_IDLE_INTERVAL_MS}ms — prefer matching ` +
      `cadence to the signal (e.g. wait on work.completed) instead of sub-minute idle polls`
    );
  }
  return null;
}

export class LoopGuardRegistry {
  private readonly loops = new Map<string, LoopState>();

  arm(input: ArmLoopInput): LoopState {
    const now = input.now ?? Date.now();
    const noopLimit =
      typeof input.noopLimit === 'number' && input.noopLimit > 0
        ? Math.floor(input.noopLimit)
        : DEFAULT_NOOP_LIMIT;
    const cadenceWarning = cadenceWarningForInterval(input.intervalMs);
    if (cadenceWarning === 'intervalMs must be a positive number') {
      throw new Error(cadenceWarning);
    }
    const state: LoopState = {
      loopId: input.loopId,
      agentId: input.agentId,
      intervalMs: input.intervalMs,
      consecutiveNoOps: 0,
      noopLimit,
      status: 'armed',
      cadenceWarning,
      tickCount: 0,
      createdAt: now,
      updatedAt: now,
      lastSignal: cadenceWarning,
    };
    this.loops.set(input.loopId, state);
    return { ...state };
  }

  get(loopId: string): LoopState | null {
    const s = this.loops.get(loopId);
    return s ? { ...s } : null;
  }

  tick(input: TickLoopInput): LoopState {
    const s = this.loops.get(input.loopId);
    if (!s) throw new Error(`unknown loopId: ${input.loopId}`);
    if (s.status === 'stopped') throw new Error(`loop ${input.loopId} is stopped`);
    if (s.status === 'paused') throw new Error(`loop ${input.loopId} is paused — resume first`);

    const now = input.now ?? Date.now();
    s.tickCount += 1;
    s.updatedAt = now;

    if (input.advanced) {
      s.consecutiveNoOps = 0;
      s.status = 'armed';
      s.lastSignal = null;
    } else {
      s.consecutiveNoOps += 1;
      if (s.consecutiveNoOps >= s.noopLimit) {
        s.status = 'not_advancing';
        s.lastSignal = `loop not advancing — ${s.consecutiveNoOps} consecutive no-ops (limit ${s.noopLimit}); stop or widen`;
      } else {
        s.lastSignal = null;
      }
    }
    return { ...s };
  }

  pause(loopId: string, now = Date.now()): LoopState {
    const s = this.require(loopId);
    if (s.status === 'stopped') throw new Error(`loop ${loopId} is stopped`);
    s.status = 'paused';
    s.updatedAt = now;
    s.lastSignal = 'paused';
    return { ...s };
  }

  resume(loopId: string, now = Date.now()): LoopState {
    const s = this.require(loopId);
    if (s.status === 'stopped') throw new Error(`loop ${loopId} is stopped`);
    s.status = 'armed';
    s.updatedAt = now;
    s.lastSignal = null;
    return { ...s };
  }

  stop(loopId: string, now = Date.now()): LoopState {
    const s = this.require(loopId);
    s.status = 'stopped';
    s.updatedAt = now;
    s.lastSignal = 'stopped';
    return { ...s };
  }

  private require(loopId: string): LoopState {
    const s = this.loops.get(loopId);
    if (!s) throw new Error(`unknown loopId: ${loopId}`);
    return s;
  }
}

/** Process-wide registry (one daemon process). */
export const loopGuards = new LoopGuardRegistry();
