/**
 * GAP-362 — prefer long-poll over client-side task polling.
 *
 * Thin adapter helper: call `events.wait` with `work.completed` so harnesses
 * wake on completion instead of self-scheduled sub-minute polls.
 */

export const WORK_COMPLETED_EVENT = 'work.completed';

export interface WaitForWorkParams {
  /** Exclusive lower bound on event id (default 0). */
  sinceId?: number;
  /** Cap wait (ms); daemon clamps 100–120_000. Default 30_000. */
  timeoutMs?: number;
}

export interface WaitForWorkResult<TEvent = unknown> {
  event: TEvent | null;
  timedOut: boolean;
}

/**
 * Shape expected from a daemon RPC client: (method, params) → result.
 */
export type DaemonRpc = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * Long-poll until a `work.completed` event arrives (or timeout).
 * Prefer this over `setInterval` + `events.query` / `tasks.*` polls.
 */
export async function waitForWorkCompleted(
  rpc: DaemonRpc,
  params: WaitForWorkParams = {},
): Promise<WaitForWorkResult> {
  const result = await rpc('events.wait', {
    eventType: WORK_COMPLETED_EVENT,
    sinceId: params.sinceId ?? 0,
    timeoutMs: params.timeoutMs ?? 30_000,
  });
  return {
    event: (result.event as unknown) ?? null,
    timedOut: result.timedOut === true,
  };
}
