/**
 * B6 item 8 regression guard — the verified-principal invariant.
 *
 * Self-scoped coordination handlers each return or mutate exactly ONE agent's
 * data, so each MUST resolve its principal via `requireVerifiedAgent` (a
 * per-request signature, or a register/attach/param bind to a daemon-minted
 * identity) and MUST NOT reintroduce the spoofable `requireAgent` actorAgentId
 * fallback or a `params.agentId` override that let agent B name agent A and
 * read/act as them (the mail.inbox / memory.query cross-agent leaks).
 *
 * This is a SOURCE assertion (analogous to the license no-wildcard test) so a
 * future handler cannot quietly reopen the leak — it fails the build, not a
 * review.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(join(here, '..', 'server.ts'), 'utf8');

// Self-scoped coordination methods: each touches exactly one agent's data.
const SELF_SCOPED = [
  'mail.send',
  'mail.inbox',
  'mail.broadcast',
  'mail.markRead',
  'files.reserve',
  'files.check',
  'files.release',
  'files.list',
  'tasks.claim',
  'tasks.complete',
  'tasks.release',
  'memory.store',
  'memory.query',
];

/** Slice out a single registerHandler('<method>', …) body. */
function handlerBody(method: string): string {
  const marker = `registerHandler('${method}',`;
  const start = SERVER_SRC.indexOf(marker);
  if (start === -1) throw new Error(`handler not found: ${method}`);
  const next = SERVER_SRC.indexOf('registerHandler(', start + marker.length);
  return SERVER_SRC.slice(start, next === -1 ? undefined : next);
}

describe('B6 verified-principal guard', () => {
  it('the spoofable requireAgent fallback has no remaining call sites', () => {
    // The function was removed; only its name in a doc comment may remain.
    expect(SERVER_SRC.includes('requireAgent(')).toBe(false);
  });

  it('mail.inbox binds the verified caller, never a params.agentId override', () => {
    const body = handlerBody('mail.inbox');
    expect(body.includes('params.agentId')).toBe(false);
    expect(body.includes('requireVerifiedAgent')).toBe(true);
  });

  for (const method of SELF_SCOPED) {
    it(`${method} resolves its principal via requireVerifiedAgent`, () => {
      expect(handlerBody(method).includes('requireVerifiedAgent')).toBe(true);
    });
  }
});
