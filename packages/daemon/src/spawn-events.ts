/**
 * Push feed for `agent.*` PTY output/exit, additive to the poll-based
 * `agent.output` RPC (see spawn.ts). `spawn.ts` is the storage of record —
 * every chunk still lands in `agent_process_output` for poll-based catch-up
 * — this EventEmitter exists only so the HTTP gateway's SSE endpoint
 * (`GET /api/stream/:processId`) has a live feed to relay, mirroring what
 * `@revealui/harnesses` `server/spawner-service.ts` gave `http-gateway.ts`
 * before the port. No auth surface: SSE access is gated upstream by the
 * gateway's bearer-token check before this module is ever touched.
 */

import { EventEmitter } from 'node:events';

export interface AgentOutputEvent {
  processId: string;
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface AgentExitEvent {
  processId: string;
  code: number | null;
}

class AgentEventBus extends EventEmitter {
  emitOutput(evt: AgentOutputEvent): void {
    this.emit('output', evt);
  }
  emitExit(evt: AgentExitEvent): void {
    this.emit('exit', evt);
  }
}

/** Process-wide singleton — one daemon process, one PTY registry (spawn.ts). */
export const agentEvents = new AgentEventBus();
