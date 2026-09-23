import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdleStop } from '../idle-stop.js';

describe('createIdleStop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires only after the idle window with zero clients', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    let clients = 0;
    const idle = createIdleStop({
      idleStopMs: 5_000,
      isBusy: () => clients > 0,
      onIdle,
    });

    idle.arm();
    vi.advanceTimersByTime(4_999);
    expect(onIdle).not.toHaveBeenCalled();

    clients = 1;
    idle.onConnect();
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();

    clients = 0;
    idle.onDisconnect();
    vi.advanceTimersByTime(5_000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('does nothing when idle stop is disabled', () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const idle = createIdleStop({
      idleStopMs: 0,
      isBusy: () => false,
      onIdle,
    });
    idle.arm();
    idle.onDisconnect();
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
