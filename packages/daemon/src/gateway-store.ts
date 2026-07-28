/**
 * HTTP gateway authn substrate — bootstrap secret hash + hashed bearer
 * tokens (migration 0008). Ported from `@revealui/harnesses`
 * `storage/daemon-store.ts` gateway methods, adapted to this package's plain
 * function-over-`db: PGlite` convention (see permission.ts) rather than a
 * store class, since the daemon has no `DaemonStore` abstraction.
 */

import type { PGlite } from '@electric-sql/pglite';

export interface GatewayBootstrapRow {
  id: number;
  secret_hash: string;
  created_at: string;
}

export interface GatewayTokenRow {
  token_hash: string;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  label: string | null;
}

/**
 * Persist the SHA-256 hash of the bootstrap pairing secret (singleton row).
 * Upserts so a fresh data dir can re-adopt an existing on-disk secret file.
 */
export async function putBootstrapSecretHash(
  db: PGlite,
  secretHash: string,
): Promise<GatewayBootstrapRow> {
  const result = await db.query<GatewayBootstrapRow>(
    `INSERT INTO gateway_bootstrap (id, secret_hash)
     VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET secret_hash = EXCLUDED.secret_hash
     RETURNING *`,
    [secretHash],
  );
  // RETURNING * always produces a row for INSERT ... ON CONFLICT DO UPDATE
  return result.rows[0] as GatewayBootstrapRow;
}

/** Get the persisted bootstrap secret hash, or null if never set. */
export async function getBootstrapSecretHash(db: PGlite): Promise<string | null> {
  const result = await db.query<GatewayBootstrapRow>(
    'SELECT * FROM gateway_bootstrap WHERE id = 1',
  );
  return result.rows[0]?.secret_hash ?? null;
}

/** Insert a hashed bearer token with optional expiry and label. */
export async function insertToken(
  db: PGlite,
  token: { tokenHash: string; expiresAt?: string | null; label?: string | null },
): Promise<GatewayTokenRow> {
  const result = await db.query<GatewayTokenRow>(
    `INSERT INTO gateway_tokens (token_hash, expires_at, label)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [token.tokenHash, token.expiresAt ?? null, token.label ?? null],
  );
  // RETURNING * always produces a row for a plain INSERT
  return result.rows[0] as GatewayTokenRow;
}

/** Find a token by hash that is neither revoked nor expired. */
export async function findValidToken(
  db: PGlite,
  tokenHash: string,
): Promise<GatewayTokenRow | null> {
  const result = await db.query<GatewayTokenRow>(
    `SELECT * FROM gateway_tokens
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/** Revoke a token by hash. Returns true if a non-revoked token was revoked. */
export async function revokeToken(db: PGlite, tokenHash: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE gateway_tokens SET revoked_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING token_hash`,
    [tokenHash],
  );
  return (result.rows?.length ?? 0) > 0;
}

/** Delete tokens whose expiry has passed. Returns the number removed. */
export async function pruneExpiredTokens(db: PGlite): Promise<number> {
  const result = await db.query(
    'DELETE FROM gateway_tokens WHERE expires_at IS NOT NULL AND expires_at < NOW()',
  );
  return result.affectedRows ?? 0;
}
