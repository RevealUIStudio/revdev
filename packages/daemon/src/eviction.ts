/**
 * Eviction pub/sub hub — lets handler modules (filegit.ts, etc.) register
 * cleanup callbacks that server.ts fires when an agent session ends.
 *
 * This module exists to avoid a circular import: filegit.ts already imports
 * `registerHandler` from server.ts. If server.ts imported filegit.ts to call
 * `evictRootsForAgent` directly the two modules would form a cycle. The hub
 * sits at zero dependencies so both sides can import it safely.
 */

import type { PGlite } from '@electric-sql/pglite';

// ---------------------------------------------------------------------------
// Agent-ended hooks (session.end / harness.prune)
// ---------------------------------------------------------------------------

type AgentEndedHook = (agentId: string, db: PGlite) => void;
const hooks: AgentEndedHook[] = [];

/** Register a cleanup hook to be called whenever an agent session ends. */
export function onAgentEnded(hook: AgentEndedHook): void {
  hooks.push(hook);
}

/** Fire all registered cleanup hooks for the given agentId. */
export function notifyAgentEnded(agentId: string, db: PGlite): void {
  for (const hook of hooks) hook(agentId, db);
}

// ---------------------------------------------------------------------------
// Daemon-started hooks (startDaemon)
//
// Used by modules that need to run async startup work (e.g. restoring
// persisted state from PGlite) without creating a circular import with
// server.ts. filegit.ts registers via onDaemonStarted; server.ts fires
// notifyDaemonStarted after migration — same pattern as the eviction hub.
// ---------------------------------------------------------------------------

type DaemonStartedHook = (db: PGlite) => Promise<void>;
const startedHooks: DaemonStartedHook[] = [];

/** Register a hook to run once after the daemon DB is migrated and ready. */
export function onDaemonStarted(hook: DaemonStartedHook): void {
  startedHooks.push(hook);
}

/** Fire all daemon-started hooks. Called by startDaemon after migration. */
export async function notifyDaemonStarted(db: PGlite): Promise<void> {
  for (const hook of startedHooks) await hook(db);
}
