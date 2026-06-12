/**
 * Versioned schema migrations for the daemon's PGlite database.
 *
 * The registry lives in `src/migrations/` (TS modules, not loose .sql
 * files — tsup bundles the daemon into dist/, and runtime-loaded files
 * would be dropped from the bundle). Each migration runs exactly once,
 * inside a transaction, in ascending version order; the applied set is
 * recorded in the `schema_version` table.
 *
 * Failure policy is fail-fast: a failed migration rolls back its own
 * transaction, leaves `schema_version` untouched, and throws
 * MigrationError — callers (startDaemon, the `migrate` CLI subcommand)
 * refuse to proceed rather than run on a half-migrated schema.
 */

import type { PGlite } from '@electric-sql/pglite';
import { MIGRATIONS } from '../migrations/index.js';

/** One schema migration. Registered in `src/migrations/index.ts`. */
export interface Migration {
  /** Strictly increasing positive integer; 1 is the frozen baseline. */
  version: number;
  /** Kebab-case label, recorded in `schema_version.name`. */
  name: string;
  /** SQL applied inside a single transaction. */
  sql: string;
}

/** Pending/current snapshot returned by {@link migrationStatus}. */
export interface MigrationStatus {
  /** Highest applied version (0 = nothing recorded yet). */
  current: number;
  /** Highest version known to this daemon build. */
  latest: number;
  /** Migrations this daemon would apply, in order. */
  pending: ReadonlyArray<{ version: number; name: string }>;
}

export class MigrationError extends Error {
  readonly version: number | undefined;

  constructor(message: string, version?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
    this.version = version;
  }
}

const SCHEMA_VERSION_SQL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TIMESTAMP NOT NULL DEFAULT NOW()
  );
`;

/**
 * Reject malformed registries before touching the database: versions must
 * be positive integers, unique, and listed in ascending order; every entry
 * needs a name and non-empty SQL.
 */
function validateRegistry(migrations: readonly Migration[]): void {
  let prev = 0;
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= 0) {
      throw new MigrationError(
        `invalid migration version ${String(m.version)} (${m.name}) — versions are positive integers`,
        m.version,
      );
    }
    if (m.version <= prev) {
      throw new MigrationError(
        `migration registry out of order at version ${m.version} (${m.name}) — versions must be unique and ascending`,
        m.version,
      );
    }
    if (!m.name.trim() || !m.sql.trim()) {
      throw new MigrationError(`migration ${m.version} has an empty name or empty sql`, m.version);
    }
    prev = m.version;
  }
}

async function currentVersion(db: PGlite): Promise<number> {
  await db.exec(SCHEMA_VERSION_SQL);
  const result = await db.query<{ v: number }>(
    'SELECT COALESCE(MAX(version), 0)::int AS v FROM schema_version',
  );
  return result.rows[0]?.v ?? 0;
}

/** Report current/latest/pending without applying anything. */
export async function migrationStatus(
  db: PGlite,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrationStatus> {
  validateRegistry(migrations);
  const current = await currentVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  const pending = migrations
    .filter((m) => m.version > current)
    .map((m) => ({ version: m.version, name: m.name }));
  return { current, latest, pending };
}

/**
 * Apply every pending migration in ascending order. Each migration's SQL
 * and its `schema_version` insert share one transaction, so a failure
 * rolls back cleanly and the next attempt resumes at the failed version.
 *
 * A database whose recorded version is NEWER than this build's registry
 * is refused outright — running old code against a future schema is the
 * one corruption mode a version table cannot repair.
 *
 * Pre-migration databases (created when startup ran the baseline SQL
 * directly) adopt cleanly: the baseline migration is idempotent
 * (IF NOT EXISTS throughout), so applying it over existing tables is a
 * no-op that simply records version 1.
 */
export async function migrate(
  db: PGlite,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ current: number; applied: number[] }> {
  validateRegistry(migrations);
  let current = await currentVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;

  if (current > latest) {
    throw new MigrationError(
      `database schema version ${current} is newer than this daemon's latest known migration (${latest}) — refusing to start against a future schema; upgrade the daemon instead`,
      current,
    );
  }

  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= current) continue;
    try {
      await db.transaction(async (tx) => {
        await tx.exec(m.sql);
        await tx.query('INSERT INTO schema_version (version, name) VALUES ($1, $2)', [
          m.version,
          m.name,
        ]);
      });
    } catch (err) {
      throw new MigrationError(
        `migration ${m.version} (${m.name}) failed and was rolled back: ${String(err)}`,
        m.version,
        { cause: err },
      );
    }
    applied.push(m.version);
    current = m.version;
  }

  return { current, applied };
}
