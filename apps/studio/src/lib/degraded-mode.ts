import { useSyncExternalStore } from 'react';

/**
 * Global "degraded mode" signal.
 *
 * Degraded mode means the app is showing mocked / fabricated / offline-default
 * data instead of real system state. The app shell renders one persistent
 * banner whenever it is active, so an operator can never mistake demo data for
 * a real system (e.g. a fabricated "deployment is live" with placeholder
 * secrets, or green "running" service cards that reflect nothing).
 *
 * Today the dominant trigger is running outside the Tauri desktop app (browser
 * preview): every `!isTauri()` fallback — `invoke()` MOCK_DATA, the deploy-lib
 * mocks, the browser config short-circuit — is degraded by definition. A
 * mutable `markDegraded()` escalation hook is also provided so any genuinely
 * runtime fallback (e.g. a remote daemon going unreachable) can flip the flag.
 *
 * Backed by useSyncExternalStore so React re-renders when the flag changes.
 */

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

const BROWSER_REASON =
  'Demo data. Not connected to a real system (running outside the desktop app).';

export interface DegradedState {
  degraded: boolean;
  reason: string | null;
}

let runtimeDegraded = false;
let runtimeReason: string | null = null;
const listeners = new Set<() => void>();

function compute(): DegradedState {
  if (!isTauri()) {
    return { degraded: true, reason: BROWSER_REASON };
  }
  if (runtimeDegraded) {
    return { degraded: true, reason: runtimeReason };
  }
  return { degraded: false, reason: null };
}

// useSyncExternalStore requires a referentially-stable snapshot between
// changes, so cache it and only rebuild when the state actually moves.
let snapshot: DegradedState = compute();

/**
 * Escalate into degraded mode at runtime with a human-readable reason.
 * Idempotent for the same reason (no spurious re-renders).
 */
export function markDegraded(reason: string): void {
  if (runtimeDegraded && runtimeReason === reason) {
    return;
  }
  runtimeDegraded = true;
  runtimeReason = reason;
  snapshot = compute();
  for (const listener of listeners) {
    listener();
  }
}

/** Imperative read for non-React callers. */
export function isDegradedMode(): boolean {
  return compute().degraded;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): DegradedState {
  return snapshot;
}

/** React hook — reactive degraded-mode state for the shell banner. */
export function useDegradedMode(): DegradedState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only reset of the runtime escalation (does not affect isTauri()). */
export function __resetDegradedModeForTests(): void {
  runtimeDegraded = false;
  runtimeReason = null;
  snapshot = compute();
}
