/**
 * GAP-362 — loop cadence + no-op tracker (pure).
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { notifyAgentEnded } from '../eviction.js';
import {
  cadenceWarningForInterval,
  DEFAULT_NOOP_LIMIT,
  LoopGuardRegistry,
  loopGuards,
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

  it('applies the default noop limit of 3 when the caller omits it', () => {
    const reg = new LoopGuardRegistry();
    const armed = reg.arm({ loopId: 'def', agentId: 'a1', intervalMs: 120_000 });
    expect(armed.noopLimit).toBe(DEFAULT_NOOP_LIMIT);
    expect(DEFAULT_NOOP_LIMIT).toBe(3);
    expect(reg.tick({ loopId: 'def', advanced: false }).status).toBe('armed');
    expect(reg.tick({ loopId: 'def', advanced: false }).consecutiveNoOps).toBe(2);
    const third = reg.tick({ loopId: 'def', advanced: false });
    expect(third.status).toBe('not_advancing');
    expect(third.tickCount).toBe(3);
    expect(third.lastSignal).toMatch(/not advancing/);
    // A further no-op tick is still counted. It is not dropped.
    const fourth = reg.tick({ loopId: 'def', advanced: false });
    expect(fourth.tickCount).toBe(4);
    expect(fourth.status).toBe('not_advancing');
    expect(fourth.consecutiveNoOps).toBe(4);
  });

  it('rejects a tick that omits advanced instead of ignoring it', () => {
    const reg = new LoopGuardRegistry();
    reg.arm({ loopId: 'bad', agentId: 'a1', intervalMs: 120_000 });
    expect(() => reg.tick({ loopId: 'bad', advanced: undefined as unknown as boolean })).toThrow(
      /advanced/,
    );
    expect(reg.get('bad')?.tickCount).toBe(0);
  });

  it('rejects an unknown loopId instead of a silent success', () => {
    const reg = new LoopGuardRegistry();
    expect(() => reg.tick({ loopId: 'missing', advanced: true })).toThrow(/unknown loopId/);
  });

  it('does not clear no-op progress when the owner re-arms', () => {
    const reg = new LoopGuardRegistry();
    reg.arm({ loopId: 'keep', agentId: 'a1', intervalMs: 120_000 });
    reg.tick({ loopId: 'keep', advanced: false });
    reg.tick({ loopId: 'keep', advanced: false });
    const again = reg.arm({ loopId: 'keep', agentId: 'a1', intervalMs: 90_000 });
    expect(again.consecutiveNoOps).toBe(2);
    expect(again.tickCount).toBe(2);
    expect(again.noopLimit).toBe(DEFAULT_NOOP_LIMIT);
    const third = reg.tick({ loopId: 'keep', advanced: false });
    expect(third.status).toBe('not_advancing');
  });

  it('refuses to let another agent take over a live loop id', () => {
    const reg = new LoopGuardRegistry();
    reg.arm({ loopId: 'owned', agentId: 'a1', intervalMs: 120_000, sessionId: 'a1' });
    expect(() =>
      reg.arm({ loopId: 'owned', agentId: 'a2', intervalMs: 120_000, sessionId: 'a2' }),
    ).toThrow(/owned by another agent/);
    expect(reg.get('owned')?.agentId).toBe('a1');
  });

  it('reaps session-attached loops and leaves other agents', () => {
    const reg = new LoopGuardRegistry();
    reg.arm({ loopId: 'mine', agentId: 'a1', intervalMs: 120_000, sessionId: 'a1' });
    reg.arm({ loopId: 'theirs', agentId: 'a2', intervalMs: 120_000, sessionId: 'a2' });
    // Attached by session id even when the owner id differs.
    reg.arm({ loopId: 'guest', agentId: 'a3', intervalMs: 120_000, sessionId: 'a1' });
    const reaped = reg.reapAgent('a1');
    expect(reaped.map((s) => s.loopId).sort()).toEqual(['guest', 'mine']);
    expect(reaped.every((s) => s.status === 'stopped')).toBe(true);
    expect(reaped.every((s) => s.lastSignal === 'reaped with session')).toBe(true);
    expect(reg.get('mine')).toBeNull();
    expect(reg.get('guest')).toBeNull();
    expect(reg.get('theirs')?.agentId).toBe('a2');
    expect(() => reg.tick({ loopId: 'mine', advanced: false })).toThrow(/unknown loopId/);
    // The id can be armed again after reap. It is not a stuck orphan.
    const fresh = reg.arm({ loopId: 'mine', agentId: 'a2', intervalMs: 120_000, sessionId: 'a2' });
    expect(fresh.status).toBe('armed');
    expect(fresh.tickCount).toBe(0);
  });

  it('starts fresh when the owner re-arms a stopped loop', () => {
    const reg = new LoopGuardRegistry();
    reg.arm({ loopId: 'restart', agentId: 'a1', intervalMs: 120_000 });
    reg.tick({ loopId: 'restart', advanced: false });
    reg.stop('restart');
    const fresh = reg.arm({ loopId: 'restart', agentId: 'a1', intervalMs: 120_000 });
    expect(fresh.status).toBe('armed');
    expect(fresh.tickCount).toBe(0);
    expect(fresh.consecutiveNoOps).toBe(0);
  });
});

describe('session end hook', () => {
  it('reaps the process registry when the agent session ends', () => {
    const mine = `hook-${Date.now()}`;
    const other = `hook-other-${Date.now()}`;
    loopGuards.arm({
      loopId: mine,
      agentId: 'hook-agent',
      intervalMs: 120_000,
      sessionId: 'hook-agent',
    });
    loopGuards.arm({
      loopId: other,
      agentId: 'hook-peer',
      intervalMs: 120_000,
      sessionId: 'hook-peer',
    });
    const queries: string[] = [];
    notifyAgentEnded('hook-agent', {
      query: (sql: string) => {
        queries.push(sql);
        return Promise.resolve({ rows: [] });
      },
    } as never);
    expect(loopGuards.get(mine)).toBeNull();
    expect(loopGuards.get(other)?.agentId).toBe('hook-peer');
    expect(
      queries.some((sql) => sql.includes('loop.reaped') || sql.includes('INSERT INTO events')),
    ).toBe(true);
    loopGuards.reapAgent('hook-peer');
  });
});
