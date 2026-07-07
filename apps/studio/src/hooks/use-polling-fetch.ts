/**
 * usePollingFetch — fire an async fetcher on mount + at a fixed interval,
 * with full abort + isMounted hygiene.
 *
 * Why: every studio polling hook (useStatus, useHealth, useSubscription,
 * useRvuiBalance, …) was hand-rolling an initial fetch + a
 * setInterval, with no AbortController and no isMounted guard. Initial
 * fetches that resolved post-unmount (e.g. inside a Vitest jsdom
 * teardown, or a real user closing a window mid-fetch) called setState
 * against a torn-down React tree, which crashed React 19's
 * dispatchSetState path with "ReferenceError: window is not defined".
 * The Pillar 1 §C audit catalogued ~30 production surfaces sharing
 * this gap (revdev studio + revealui admin + @revealui/ai Pro hooks).
 *
 * Behavioral contract:
 *   - Fires fn(signal) on mount.
 *   - Re-fires fn(signal) every intervalMs while mounted (when intervalMs
 *     is a positive number; null / 0 / negative disables polling).
 *   - On unmount: aborts the in-flight signal and clears the interval.
 *   - Aborts the previous in-flight call before firing a new one (no
 *     overlap; the most-recent call always wins).
 *   - Swallows AbortError + TimeoutError silently (those are the helper's
 *     own abort, not real failures).
 *   - Surfaces other errors via `error` state. Successful resolves clear
 *     the previous error.
 *   - Never sets state after unmount.
 *
 * Caller contract:
 *   - `fn` should be wrapped in `useCallback` so its identity only changes
 *     when its inputs change. The hook restarts when `fn` changes
 *     (new initial fetch + new interval bound to the new fn).
 *   - `fn` should propagate the provided AbortSignal to any abortable
 *     work it does (e.g. `fetch(url, { signal })`). For non-abortable
 *     work (Tauri invoke etc.), the signal is still useful — the helper
 *     drops the result if the signal aborted before resolution.
 *   - Polling can be conditionally disabled by passing `null` for
 *     `intervalMs` (e.g. "wait until authenticated, then poll").
 */

import type { DependencyList } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UsePollingFetchResult<T> {
  /** Most-recent successful result; null until the first resolve. */
  data: T | null;
  /** Most-recent unhandled error; null after a successful resolve. */
  error: Error | null;
  /** True from the start of the most-recent call until it resolves or aborts. */
  loading: boolean;
  /** Trigger an immediate re-fetch. Returns a Promise that resolves
   *  when the call completes (success, error, or abort). */
  refresh: () => Promise<void>;
}

function isAbortLike(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

export function usePollingFetch<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  intervalMs: number | null,
): UsePollingFetchResult<T>;
export function usePollingFetch<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  intervalMs: number | null,
  // Reserved for callers that prefer explicit deps over useCallback-on-fn.
  // The hook also re-runs when any dep changes.
  deps: DependencyList,
): UsePollingFetchResult<T>;
export function usePollingFetch<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  intervalMs: number | null,
  deps?: DependencyList,
): UsePollingFetchResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const isMountedRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);

  // Stable ref to fn so internal helpers can read it without going stale.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const runOnce = useCallback(async (): Promise<void> => {
    // Abort any in-flight call before starting a new one. The previous
    // call's result-handling block sees ctrl.signal.aborted and bails
    // before touching state.
    controllerRef.current?.abort();
    const ctrl = new AbortController();
    controllerRef.current = ctrl;

    if (isMountedRef.current) setLoading(true);

    try {
      const result = await fnRef.current(ctrl.signal);
      if (!isMountedRef.current || ctrl.signal.aborted) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (!isMountedRef.current || ctrl.signal.aborted) return;
      // Swallow our own abort. AbortError fires when ctrl.abort() races
      // a fetch call; TimeoutError fires when the consumer combined the
      // helper's signal with AbortSignal.timeout. Both are expected,
      // not real failures.
      if (isAbortLike(err)) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (isMountedRef.current && !ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps from caller, intentional
  useEffect(() => {
    isMountedRef.current = true;
    runOnce();

    let interval: ReturnType<typeof setInterval> | null = null;
    if (intervalMs !== null && intervalMs > 0) {
      interval = setInterval(() => {
        runOnce();
      }, intervalMs);
    }

    return () => {
      isMountedRef.current = false;
      controllerRef.current?.abort();
      if (interval !== null) clearInterval(interval);
    };
    // The effect depends on `intervalMs` (controls the timer) and on
    // `fn`'s identity (so callers' `useCallback` dep changes restart
    // the loop) plus any extra `deps` the caller wants to track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, fn, runOnce, ...(deps ?? [])]);

  return { data, error, loading, refresh: runOnce };
}
