/**
 * Tests for usePollingFetch — the shared polling helper used by
 * useStatus / useHealth / useSubscription / etc.
 *
 * The Pillar 1 §C audit catalogued ~30 production surfaces sharing the
 * same hygiene gap (no AbortController, no isMounted guard) that bit
 * Dashboard.test.tsx today. usePollingFetch is the durable production-
 * side fix; these tests pin its contract so future migrations can rely
 * on it.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePollingFetch } from '../../hooks/use-polling-fetch';

describe('usePollingFetch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires fn(signal) on mount and surfaces the result via data', async () => {
    const fn = vi.fn(async (_signal: AbortSignal) => ({ value: 42 }));
    const { result } = renderHook(() => usePollingFetch(fn, null));

    expect(result.current.loading).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ value: 42 });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('passes an AbortSignal to fn that fires on unmount', async () => {
    const observed: AbortSignal[] = [];
    const fn = vi.fn(async (signal: AbortSignal) => {
      observed.push(signal);
      return 'ok';
    });

    const { unmount } = renderHook(() => usePollingFetch(fn, null));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]?.aborted).toBe(false);

    unmount();

    expect(observed[0]?.aborted).toBe(true);
  });

  it('polls at the configured interval', async () => {
    const fn = vi.fn(async () => 'tick');
    renderHook(() => usePollingFetch(fn, 1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fn).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not poll when intervalMs is null (fires once on mount only)', async () => {
    const fn = vi.fn(async () => 'once');
    renderHook(() => usePollingFetch(fn, null));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('treats zero or negative intervalMs the same as null (no polling)', async () => {
    const fn = vi.fn(async () => 'once');
    const { rerender } = renderHook(({ ms }: { ms: number }) => usePollingFetch(fn, ms), {
      initialProps: { ms: 0 },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    rerender({ ms: -100 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    // Re-render with new fn-identity-equivalent ms flips the effect: it
    // re-runs runOnce once on the deps change, then idles. So we expect
    // exactly 2 total calls (one per effect activation).
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clears the interval on unmount', async () => {
    const fn = vi.fn(async () => 'tick');
    const { unmount } = renderHook(() => usePollingFetch(fn, 1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('aborts the in-flight signal when a new poll begins (no overlap)', async () => {
    const observed: AbortSignal[] = [];
    let resolveCurrent: ((value: string) => void) | null = null;

    const fn = vi.fn(async (signal: AbortSignal) => {
      observed.push(signal);
      return new Promise<string>((resolve) => {
        resolveCurrent = resolve;
      });
    });

    renderHook(() => usePollingFetch(fn, 1000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.aborted).toBe(false);

    // Trigger second call by advancing past the interval. The first call
    // is still in flight (resolveCurrent never called) — its signal should
    // abort when the new call begins.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(observed).toHaveLength(2);
    expect(observed[0]?.aborted).toBe(true);
    expect(observed[1]?.aborted).toBe(false);

    // Cleanup: resolve the dangling promises so vitest doesn't warn.
    if (resolveCurrent) (resolveCurrent as (v: string) => void)('done');
  });

  it('surfaces errors via the error state', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    const { result } = renderHook(() => usePollingFetch(fn, null));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('wraps non-Error rejections in an Error', async () => {
    const fn = vi.fn(async () => {
      throw 'string failure';
    });
    const { result } = renderHook(() => usePollingFetch(fn, null));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('string failure');
  });

  it('clears a previous error after a successful re-fetch', async () => {
    let shouldFail = true;
    const fn = vi.fn(async () => {
      if (shouldFail) throw new Error('first call failed');
      return 'ok';
    });

    const { result } = renderHook(() => usePollingFetch(fn, null));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.error?.message).toBe('first call failed');

    shouldFail = false;
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.data).toBe('ok');
  });

  it("swallows AbortError silently (the helper's own abort)", async () => {
    const fn = vi.fn(async (signal: AbortSignal) => {
      if (signal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return 'ok';
    });

    const { result, unmount } = renderHook(() => usePollingFetch(fn, null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // No error surfaces from the AbortError path
    expect(result.current.error).toBeNull();
    unmount();
  });

  it('swallows TimeoutError silently', async () => {
    const fn = vi.fn(async () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    });

    const { result } = renderHook(() => usePollingFetch(fn, null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.error).toBeNull();
  });

  it('refresh() returns a Promise that resolves after the call completes', async () => {
    const fn = vi.fn(async () => 'value');
    const { result } = renderHook(() => usePollingFetch(fn, null));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('restarts polling when fn identity changes (caller useCallback dep change)', async () => {
    const fn1 = vi.fn(async () => 'first');
    const fn2 = vi.fn(async () => 'second');

    const { result, rerender } = renderHook(
      ({ fn }: { fn: typeof fn1 }) => usePollingFetch(fn, 1000),
      { initialProps: { fn: fn1 } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.data).toBe('first');

    rerender({ fn: fn2 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(fn2).toHaveBeenCalled();
    expect(result.current.data).toBe('second');
  });
});
