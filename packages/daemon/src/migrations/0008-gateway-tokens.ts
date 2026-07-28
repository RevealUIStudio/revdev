/**
 * Migration 0008 — HTTP gateway pairing tokens (GAP-421 daemon-ownership ADR).
 *
 * Ported from `@revealui/harnesses` `storage/schema.ts` (`gateway_bootstrap` +
 * `gateway_tokens`), byte-identical column shape so the on-the-wire pairing
 * contract (GET/POST /api/pair, Bearer auth on /rpc and /api/*) needs no
 * protocol change. `gateway_bootstrap` is a singleton row recording the
 * SHA-256 hash of the 0600 bootstrap pairing-secret file; `gateway_tokens`
 * holds hashed durable bearer tokens minted on successful pairing.
 */

import type { Migration } from '../storage/migrate.js';

const SQL = `
  CREATE TABLE IF NOT EXISTS gateway_bootstrap (
    id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    secret_hash   TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS gateway_tokens (
    token_hash    TEXT PRIMARY KEY,
    issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ,
    label         TEXT
  );
`;

export const MIGRATION_0008: Migration = {
  version: 8,
  name: 'gateway-tokens',
  sql: SQL,
};
