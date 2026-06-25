/**
 * Eviction pub/sub hub — lets handler modules (filegit.ts, etc.) register
 * cleanup callbacks that server.ts fires when an agent session ends.
 *
 * This module exists to avoid a circular import: filegit.ts already imports
 * `registerHandler` from server.ts. If server.ts imported filegit.ts to call
 * `evictRootsForAgent` directly the two modules would form a cycle. The hub
 * sits at zero dependencies so both sides can import it safely.
 */

type AgentEndedHook = (agentId: string) => void;
const hooks: AgentEndedHook[] = [];

/** Register a cleanup hook to be called whenever an agent session ends. */
export function onAgentEnded(hook: AgentEndedHook): void {
  hooks.push(hook);
}

/** Fire all registered cleanup hooks for the given agentId. */
export function notifyAgentEnded(agentId: string): void {
  for (const hook of hooks) hook(agentId);
}
