/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';
import { runWorkCompletedRefreshLoop } from '../../lib/work-completed-refresh';

describe('runWorkCompletedRefreshLoop', () => {
  it('calls onEvent when wait returns an event and advances sinceId', async () => {
    const ac = new AbortController();
    let calls = 0;
    const onEvent = vi.fn(async () => {
      calls += 1;
      if (calls >= 1) ac.abort();
    });
    const wait = vi
      .fn()
      .mockResolvedValueOnce({ event: { id: 7, event_type: 'work.completed' }, timedOut: false })
      .mockImplementation(async () => {
        // hang until abort
        await new Promise<void>(() => {});
        return { event: null, timedOut: true };
      });

    await runWorkCompletedRefreshLoop({
      signal: ac.signal,
      wait,
      onEvent,
      timeoutMs: 100,
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith({ sinceId: 0, timeoutMs: 100 });
  });

  it('re-waits on timeout without calling onEvent', async () => {
    const ac = new AbortController();
    let waits = 0;
    const onEvent = vi.fn();
    const wait = vi.fn(async () => {
      waits += 1;
      if (waits >= 2) ac.abort();
      return { event: null, timedOut: true };
    });

    await runWorkCompletedRefreshLoop({
      signal: ac.signal,
      wait,
      onEvent,
      timeoutMs: 50,
    });

    expect(onEvent).not.toHaveBeenCalled();
    expect(waits).toBeGreaterThanOrEqual(2);
  });
});
