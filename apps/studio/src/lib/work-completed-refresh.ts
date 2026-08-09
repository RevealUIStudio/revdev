/**
 * GAP-362 — browser-mode work.completed long-poll loop.
 *
 * Prefer events.wait over sub-minute tasks.list polls. Callers still keep a
 * slower fallback poll for mail/sessions/reservations that do not emit
 * work.completed.
 */

export interface WorkCompletedWaitResult {
  event: Record<string, unknown> | null;
  timedOut: boolean;
}

export type WorkCompletedWaitFn = (params: {
  sinceId: number;
  timeoutMs: number;
}) => Promise<WorkCompletedWaitResult>;

export interface RunWorkCompletedRefreshLoopOptions {
  wait: WorkCompletedWaitFn;
  onEvent: () => void | Promise<void>;
  /** Abort when the React effect cleans up. */
  signal: AbortSignal;
  /** Per wait call timeout (ms). Default 25_000. */
  timeoutMs?: number;
  /** Backoff after errors (ms). Default 2_000. */
  errorBackoffMs?: number;
  /** Extract numeric event id for sinceId cursor. */
  eventIdOf?: (event: Record<string, unknown>) => number;
}

function defaultEventId(event: Record<string, unknown>): number {
  const id = event.id ?? event.eventId;
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  if (typeof id === 'string' && id.trim() !== '') {
    const n = Number(id);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Long-poll work.completed until aborted. On each event, calls onEvent (typically
 * a full harness refresh). Timeouts just re-wait — that is the notify path.
 */
export async function runWorkCompletedRefreshLoop(
  options: RunWorkCompletedRefreshLoopOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const errorBackoffMs = options.errorBackoffMs ?? 2_000;
  const eventIdOf = options.eventIdOf ?? defaultEventId;
  let sinceId = 0;

  while (!options.signal.aborted) {
    try {
      const result = await options.wait({ sinceId, timeoutMs });
      if (options.signal.aborted) return;
      if (result.event) {
        const next = eventIdOf(result.event);
        if (next > sinceId) sinceId = next;
        await options.onEvent();
      }
    } catch {
      if (options.signal.aborted) return;
      await sleep(errorBackoffMs, options.signal);
    }
  }
}
