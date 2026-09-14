/**
 * Idle / focus re-fetch schedule for license auto-provision.
 *
 * Launch path is separate. This module is the 6h timer + ≥15 min focus/online
 * debounce. Does not add license.reload (rotation still daemon_restart).
 */

import type { LicenseProvisionOutcome } from './license-provision';

export const LICENSE_IDLE_POLL_MS = 6 * 60 * 60 * 1000;
export const LICENSE_FOCUS_DEBOUNCE_MS = 15 * 60 * 1000;

export function recordsSuccessfulCurrent(outcome: LicenseProvisionOutcome): boolean {
  switch (outcome.kind) {
    case 'provisioned':
    case 'wiped':
    case 'unchanged':
    case 'flag-off':
    case 'env-override':
      return true;
    default:
      return false;
  }
}

/** Idle tick: only after a prior successful /current, and only if 6h elapsed. */
export function shouldRunIdlePoll(
  now: number,
  lastSuccessAt: number | null,
  intervalMs = LICENSE_IDLE_POLL_MS,
): boolean {
  if (lastSuccessAt === null) return false;
  return now - lastSuccessAt >= intervalMs;
}

/** Focus/online: skip if last successful /current was < debounce. */
export function shouldRunFocusPoll(
  now: number,
  lastSuccessAt: number | null,
  debounceMs = LICENSE_FOCUS_DEBOUNCE_MS,
): boolean {
  if (lastSuccessAt === null) return false;
  return now - lastSuccessAt >= debounceMs;
}

export interface LicensePollClock {
  now: () => number;
  setIntervalFn: typeof setInterval;
  clearIntervalFn: typeof clearInterval;
  addEventListener: (type: 'focus' | 'online', listener: () => void) => void;
  removeEventListener: (type: 'focus' | 'online', listener: () => void) => void;
}

export interface LicensePollHandle {
  dispose: () => void;
  lastSuccessAt: () => number | null;
  noteSuccess: (at?: number) => void;
}

export function attachLicensePoll(
  run: () => Promise<LicenseProvisionOutcome>,
  clock: Partial<LicensePollClock> = {},
  opts: { idleMs?: number; focusDebounceMs?: number } = {},
): LicensePollHandle {
  const now = clock.now ?? Date.now;
  const setIntervalFn = clock.setIntervalFn ?? setInterval;
  const clearIntervalFn = clock.clearIntervalFn ?? clearInterval;
  const addEventListener =
    clock.addEventListener ??
    ((type, listener) => {
      globalThis.addEventListener?.(type, listener);
    });
  const removeEventListener =
    clock.removeEventListener ??
    ((type, listener) => {
      globalThis.removeEventListener?.(type, listener);
    });
  const idleMs = opts.idleMs ?? LICENSE_IDLE_POLL_MS;
  const focusDebounceMs = opts.focusDebounceMs ?? LICENSE_FOCUS_DEBOUNCE_MS;

  let lastSuccess: number | null = null;
  let inFlight = false;
  let disposed = false;
  let timer: ReturnType<typeof setIntervalFn> | undefined;

  const armIdle = () => {
    if (timer !== undefined) clearIntervalFn(timer);
    timer = setIntervalFn(() => kick('idle'), idleMs);
  };

  const kick = (gate: 'idle' | 'focus') => {
    if (disposed || inFlight) return;
    const t = now();
    const allowed =
      gate === 'idle'
        ? shouldRunIdlePoll(t, lastSuccess, idleMs)
        : shouldRunFocusPoll(t, lastSuccess, focusDebounceMs);
    if (!allowed) return;
    inFlight = true;
    run()
      .then((outcome) => {
        if (recordsSuccessfulCurrent(outcome)) {
          lastSuccess = now();
          armIdle();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };

  const onFocus = () => kick('focus');
  const onOnline = () => kick('focus');
  addEventListener('focus', onFocus);
  addEventListener('online', onOnline);
  armIdle();

  return {
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearIntervalFn(timer);
      removeEventListener('focus', onFocus);
      removeEventListener('online', onOnline);
    },
    lastSuccessAt: () => lastSuccess,
    noteSuccess: (at) => {
      lastSuccess = at ?? now();
      armIdle();
    },
  };
}
