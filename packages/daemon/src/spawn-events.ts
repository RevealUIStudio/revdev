/**
 * Push feed for `agent.*` PTY output/exit, additive to the poll-based
 * `agent.output` RPC (see spawn.ts). `spawn.ts` is the storage of record —
 * every chunk still lands in `agent_process_output` for poll-based catch-up
 * — this EventEmitter exists only so the HTTP gateway's SSE endpoint
 * (`GET /api/stream/:processId`) has a live feed to relay, mirroring what
 * `@revealui/harnesses` `server/spawner-service.ts` gave `http-gateway.ts`
 * before the port.
 *
 * Authorization (GAP-421 guardrail-2 remediation, B1): the gateway's bearer
 * token is a TRANSPORT credential (proves "this HTTP client paired with the
 * daemon"), not a principal. It is NOT sufficient to read PTY output —
 * `agent.output` requires a verified Ed25519 signer AND
 * `owner_agent === callerAgentId` (spawn.ts, the 2026-06-29 Part B
 * cross-agent PTY-hijack fix), and `/api/stream` must enforce the same. A
 * bearer-token-only client cannot subscribe directly: it must first call the
 * signature-required RPC `agent.streamTicket` (dispatchRpc — same license
 * guard, signature gate, identity gate, and `owner_agent` ownership check as
 * `agent.output`) to mint a short-lived, single-use, processId-bound ticket,
 * then present that ticket on `/api/stream/:processId?ticket=...`. The
 * ticket is the resolved principal for the stream; there is no
 * ticket-free/firehose mode.
 */

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

export interface AgentOutputEvent {
  processId: string;
  /** node-pty merges stdout/stderr into one stream; always 'stdout'. */
  stream: 'stdout';
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

// S6 (guardrail-2 remediation): each SSE connection registers two listeners
// (output + exit). The HTTP gateway independently caps concurrent SSE
// connections (MAX_SSE_CONNECTIONS in http-gateway.ts); this only raises
// Node's default-10 listener-count warning threshold to match that real
// cap, rather than actually removing a bound.
agentEvents.setMaxListeners(160);

// ---------------------------------------------------------------------------
// Stream tickets — the principal-resolution step for /api/stream.
//
// Minted only by the signature-required `agent.streamTicket` RPC handler
// (spawn.ts), which re-runs the exact `owner_agent === callerAgentId` check
// `agent.output` uses. Single-use and short-lived: redeeming a ticket
// deletes it, so a captured/logged ticket cannot be replayed to open a
// second stream once the legitimate client has connected (or once it
// expires, whichever comes first).
// ---------------------------------------------------------------------------

const STREAM_TICKET_TTL_MS = 60_000;
const STREAM_TICKET_BYTES = 32;
const MAX_PENDING_TICKETS = 256;

interface StreamTicket {
  agentId: string;
  processId: string;
  expiresAt: number;
}

const tickets = new Map<string, StreamTicket>();

function pruneExpiredTickets(now: number): void {
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(ticket);
  }
}

/**
 * Mint a single-use ticket binding (agentId, processId). Called only from
 * the `agent.streamTicket` handler AFTER it has verified the caller owns
 * `processId` — this function performs no authorization of its own.
 */
export function issueStreamTicket(
  agentId: string,
  processId: string,
  now = Date.now(),
): { ticket: string; expiresIn: number } {
  pruneExpiredTickets(now);
  if (tickets.size >= MAX_PENDING_TICKETS) {
    // Oldest-first eviction: drop the least-recently-issued ticket rather
    // than refusing a legitimate mint. Tickets are short-lived, so this
    // only bites under sustained abuse, and abuse of THIS endpoint already
    // required a valid signature.
    const oldest = tickets.keys().next().value;
    if (oldest !== undefined) tickets.delete(oldest);
  }
  const ticket = randomBytes(STREAM_TICKET_BYTES).toString('hex');
  tickets.set(ticket, { agentId, processId, expiresAt: now + STREAM_TICKET_TTL_MS });
  return { ticket, expiresIn: Math.floor(STREAM_TICKET_TTL_MS / 1000) };
}

/**
 * Redeem a ticket for a specific `processId`. Single-use: the ticket is
 * deleted whether or not it matches, so a wrong-processId presentation also
 * burns it rather than leaving it available for a correct guess. Returns
 * the bound `agentId` on success, or `null` if the ticket is unknown,
 * expired, or bound to a different `processId`.
 */
export function redeemStreamTicket(
  ticket: string,
  processId: string,
  now = Date.now(),
): { agentId: string } | null {
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  if (!entry) return null;
  if (entry.expiresAt <= now) return null;
  if (entry.processId !== processId) return null;
  return { agentId: entry.agentId };
}

/** @internal — test-only seam to assert the pending-ticket count. */
export function _pendingTicketCountForTest(): number {
  return tickets.size;
}
