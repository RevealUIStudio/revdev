/**
 * GAP-362 — loop cadence + no-op tracker (pure).
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  cadenceWarningForInterval,
  DEFAULT_NOOP_LIMIT,
  LoopGuardRegistry,
  MIN_IDLE_INTERVAL_MS,
} from '../loop-guard.js';

describe('cadenceWarningForInterval', () => {
  it('warns under one minute', () => {
    expect(cadenceWarningForInterval(5_000)).toMatch(/under/);
    expect(cadenceWarningForInterval(MIN_IDLE_INTERVAL_MS)).toBeNull();
  });

  it('rejects non-positive', () => {
    expect(cadenceWarningForInterval(0)).toMatch(/positive/);
  });
});

describe('LoopGuardRegistry', () => {
  it('arms with cadence warning for short intervals', () => {
    const reg = new LoopGuardRegistry();
    const s = reg.arm({
      loopId: 'L1',
      agentId: 'a1',
      intervalMs: 10_000,
    });
    expect(s.status).toBe('armed');
    expect(s.cadenceWarning).toMatch(/under/);
    expect(s.noopLimit).toBe(DEFAULT_NOOP_LIMIT);
  });

  it('signals not_advancing after N consecutive no-ops', () => {
    const reg = new LoopGuardRegistry();
    reg.arm({ loopId: 'L2', agentId: 'a1', intervalMs: 120_000, noopLimit: 3 });
    expect(reg.tick({ loopId: 'L2', advanced: false }).status).toBe('armed');
    expect(reg.tick({ loopId: 'L2', advanced: false }).status).toBe('armed');
    const third = reg.tick({ loopId: 'L2', advanced: false });
    expect(third.status).toBe('not_advancing');
    expect(third.consecutiveNoOps).toBe(3);
    expect(third.lastSignal).toMatch(/not advancing/);
  });

  it('resets no-op counter when work advances', () => {
    const reg = new LoopGuardRegistry();
    reg.arm({ loopId: 'L3', agentId: 'a1', intervalMs: 120_000, noopLimit: 2 });
    reg.tick({ loopId: 'L3', advanced: false });
    const ok = reg.tick({ loopId: 'L3', advanced: true });
    expect(ok.consecutiveNoOps).toBe(0);
    expect(ok.status).toBe('armed');
  });

  it('pause / resume / stop', () => {
    const reg = new LoopGuardRegistry();
    reg.arm({ loopId: 'L4', agentId: 'a1', intervalMs: 120_000 });
    expect(reg.pause('L4').status).toBe('paused');
    expect(() => reg.tick({ loopId: 'L4', advanced: true })).toThrow(/paused/);
    expect(reg.resume('L4').status).toBe('armed');
    expect(reg.stop('L4').status).toBe('stopped');
    expect(() => reg.tick({ loopId: 'L4', advanced: true })).toThrow(/stopped/);
  });

  it('accumulates spend on tick and recordSpend', () => {
    const reg = new LoopGuardRegistry();
    reg.arm({ loopId: 'L5', agentId: 'a1', intervalMs: 120_000 });
    expect(reg.spend('L5')).toEqual({ tokensIn: 0, tokensOut: 0, costMicros: 0 });
    reg.tick({ loopId: 'L5', advanced: true, tokensIn: 10, tokensOut: 20, costMicros: 500 });
    expect(reg.spend('L5')).toEqual({ tokensIn: 10, tokensOut: 20, costMicros: 500 });
    reg.recordSpend({ loopId: 'L5', tokensIn: 5, tokensOut: 0, costMicros: 100 });
    expect(reg.spend('L5')).toEqual({ tokensIn: 15, tokensOut: 20, costMicros: 600 });
    const snap = reg.get('L5');
    expect(snap?.spend.tokensIn).toBe(15);
    // clone isolation
    snap!.spend.tokensIn = 999;
    expect(reg.spend('L5')?.tokensIn).toBe(15);
  });
});
