/**
 * Studio daemon LoopGuard sock contract.
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';
import type { LoopGuardWireState } from '../loop-contract.js';
import {
  armDaemonLoop,
  DEFAULT_LOOP_NOOP_LIMIT,
  HARNESS_SOCK_DEFAULT,
  LOOP_GUARD_METHODS,
  loopMustStop,
  statusDaemonLoop,
  tickDaemonLoop,
} from '../loop-contract.js';
import { RPC_METHODS } from '../methods.js';

function loop(overrides: Partial<LoopGuardWireState> = {}): LoopGuardWireState {
  return {
    loopId: 'task-1',
    agentId: 'agent-1',
    sessionId: 'agent-1',
    intervalMs: 120_000,
    consecutiveNoOps: 0,
    noopLimit: DEFAULT_LOOP_NOOP_LIMIT,
    status: 'armed',
    cadenceWarning: null,
    tickCount: 0,
    createdAt: 1,
    updatedAt: 1,
    lastSignal: null,
    spend: { tokensIn: 0, tokensOut: 0, costMicros: 0 },
    ...overrides,
  };
}

describe('loop guard contract', () => {
  it('names the sock methods and the default noop limit', () => {
    expect(LOOP_GUARD_METHODS.arm).toBe('loop.arm');
    expect(LOOP_GUARD_METHODS.tick).toBe('loop.tick');
    expect(LOOP_GUARD_METHODS.status).toBe('loop.status');
    expect(LOOP_GUARD_METHODS.arm).toBe(RPC_METHODS['loop.arm']);
    expect(LOOP_GUARD_METHODS.tick).toBe(RPC_METHODS['loop.tick']);
    expect(LOOP_GUARD_METHODS.status).toBe(RPC_METHODS['loop.status']);
    expect(DEFAULT_LOOP_NOOP_LIMIT).toBe(3);
    expect(HARNESS_SOCK_DEFAULT).toContain('harness.sock');
    expect(loopMustStop('not_advancing')).toBe(true);
    expect(loopMustStop('armed')).toBe(false);
    expect(loopMustStop('stopped')).toBe(false);
    expect(loopMustStop(null)).toBe(false);
  });

  it('arm omits noopLimit and requires the daemon to apply 3', async () => {
    const rpc = vi.fn().mockResolvedValue({
      loop: loop(),
      stop: false,
      noopLimit: 3,
    });
    const result = await armDaemonLoop(rpc, {
      loopId: 'task-1',
      intervalMs: 120_000,
      actorAgentId: 'agent-1',
    });
    expect(rpc).toHaveBeenCalledWith('loop.arm', {
      loopId: 'task-1',
      intervalMs: 120_000,
      actorAgentId: 'agent-1',
    });
    expect(result.noopLimit).toBe(3);
    expect(result.stop).toBe(false);
  });

  it('rejects an arm response that ignores the default noop limit', async () => {
    const rpc = vi.fn().mockResolvedValue({
      loop: loop({ noopLimit: 0 }),
      stop: false,
      noopLimit: 0,
    });
    await expect(armDaemonLoop(rpc, { loopId: 'task-1', intervalMs: 120_000 })).rejects.toThrow(
      /noopLimit/,
    );
  });

  it('tick requires advanced and surfaces stop from status', async () => {
    const rpc = vi.fn().mockResolvedValue({
      loop: loop({ status: 'not_advancing', consecutiveNoOps: 3, tickCount: 3 }),
    });
    const result = await tickDaemonLoop(rpc, {
      loopId: 'task-1',
      advanced: false,
      tokensIn: 10,
    });
    expect(rpc).toHaveBeenCalledWith('loop.tick', {
      loopId: 'task-1',
      advanced: false,
      tokensIn: 10,
    });
    expect(result.stop).toBe(true);
    expect(result.loop.tickCount).toBe(3);
    await expect(
      tickDaemonLoop(rpc, { loopId: 'task-1', advanced: undefined as unknown as boolean }),
    ).rejects.toThrow(/advanced/);
  });

  it('rejects a tick response that drops the loop', async () => {
    const rpc = vi.fn().mockResolvedValue({ ok: true });
    await expect(tickDaemonLoop(rpc, { loopId: 'task-1', advanced: true })).rejects.toThrow(
      /no loop/,
    );
  });

  it('status returns null without stop after the loop is gone', async () => {
    const rpc = vi.fn().mockResolvedValue({ loop: null, stop: false, noopLimit: null });
    const result = await statusDaemonLoop(rpc, { loopId: 'task-1', actorAgentId: 'agent-1' });
    expect(rpc).toHaveBeenCalledWith('loop.status', {
      loopId: 'task-1',
      actorAgentId: 'agent-1',
    });
    expect(result.loop).toBeNull();
    expect(result.stop).toBe(false);
  });
});
