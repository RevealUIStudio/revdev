/**
 * `gateway.*` RPC handlers — the socket/HTTP-dispatchable operations on the
 * HTTP gateway's durable state (bearer tokens). Kept in its own module,
 * separate from `http-gateway.ts`, so it can be imported as a side-effect
 * from `index.ts`/`cli.ts` the same way `agent.ts`/`spawn.ts`/`vcs.ts` are:
 * AFTER `server.ts` has fully evaluated. `http-gateway.ts` itself cannot
 * hold this registration — `server.ts` imports the `HttpGateway` class
 * directly (to construct it in `startDaemon`), so anything registered at
 * `http-gateway.ts`'s module top level runs mid-way through `server.ts`'s
 * own module evaluation, before `server.ts`'s `handlers` map is
 * initialized (`ReferenceError: Cannot access 'handlers' before
 * initialization`). This module has no such cycle.
 */

import { createHash } from 'node:crypto';
import { revokeToken } from './gateway-store.js';
import { registerHandler } from './server.js';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * gateway.revokeToken — makes `revokeToken` (gateway-store.ts) reachable
 * (GAP-421 guardrail-2 remediation S5). Signature-required so an unsigned
 * caller cannot revoke another client's session, but note the scope
 * limitation: `gateway_tokens` rows carry no agent linkage (they are
 * daemon-wide bearer credentials, not per-agent), so any verified signer
 * may revoke ANY known token, not only its own. Closing that would need a
 * schema change binding a token to the agent that minted it; out of scope
 * for this fix, which only had to make revocation reachable at all.
 */
registerHandler('gateway.revokeToken', async (params, db) => {
  const token = params.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('gateway.revokeToken: missing token');
  }
  const revoked = await revokeToken(db, sha256Hex(token));
  return { revoked };
});
