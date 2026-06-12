/**
 * Migration runner tests — fresh DB, idempotent re-run, pre-migration
 * baseline adoption, sequential pending application, transactional
 * rollback on bad SQL, future-schema refusal, registry validation, and
 * the startDaemon() wiring.
 *
 * Every case boots its own PGlite instance (migration state must be
 * isolated), and a cold PGlite WASM init costs seconds — so each test
 * carries an explicit timeout instead of vitest's 5s default. CI absorbs
 * this easily; low-memory dev boxes stay green instead of flaking.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations/index.js';
import { startDaemon } from '../server.js';
import {
  type Migration,
  MigrationError,
  migrate,
  migrationStatus,
} from '../storage/migrate.js';
import { SCHEMA_SQL } from '../storage/schema.js';

/** Cold PGlite WASM init is seconds, not milliseconds — see header. */
const DB_TEST_TIMEOUT = 60_000;
/** The wiring test boots the full daemon (PGlite + socket + license guard). */
const DAEMON_TEST_TIMEOUT = 120_000;

const first = MIGRATIONS[0];
if (!first) throw new Error('migration registry is empty — baseline expected');
const BASELINE = first;

function probeMigration(version: number, table: string): Migration {
  return {
    version,
    name: `probe-${table}`,
    sql: `CREATE TABLE ${table} (id INTEGER PRIMARY KEY);`,
  };
}

async function tableExists(db: PGlite, table: string): Promise<boolean> {
  const result = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

describe('migrate()', () => {
  let db: PGlite;

  afterEach(async () => {
    await db.close().catch(() => {});
  });

  it(
    'applies the baseline on a fresh database and records version 1',
    async () => {
      db = new PGlite();
      const result = await migrate(db);

      expect(result.applied).toEqual([1]);
      expect(result.current).toBe(1);
      expect(await tableExists(db, 'agent_sessions')).toBe(true);
      expect(await tableExists(db, 'agent_identity_nonces')).toBe(true);

      const rows = await db.query<{ version: number; name: string }>(
        'SELECT version, name FROM schema_version ORDER BY version',
      );
      expect(rows.rows).toEqual([{ version: 1, name: 'initial-schema' }]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'is a no-op when already at the latest version',
    async () => {
      db = new PGlite();
      await migrate(db);
      const second = await migrate(db);

      expect(second.applied).toEqual([]);
      expect(second.current).toBe(1);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'adopts a pre-migration database (baseline SQL already executed)',
    async () => {
      db = new PGlite();
      // Simulate a deployment created before the migration system existed.
      await db.exec(SCHEMA_SQL);
      await db.query(`INSERT INTO agent_sessions (id) VALUES ('pre-existing')`);

      const result = await migrate(db);

      expect(result.applied).toEqual([1]);
      const session = await db.query<{ id: string }>('SELECT id FROM agent_sessions');
      expect(session.rows).toEqual([{ id: 'pre-existing' }]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'applies only pending migrations, in order',
    async () => {
      db = new PGlite();
      await migrate(db); // at version 1

      const registry: Migration[] = [
        BASELINE,
        probeMigration(2, 'probe_two'),
        probeMigration(3, 'probe_three'),
      ];
      const result = await migrate(db, registry);

      expect(result.applied).toEqual([2, 3]);
      expect(result.current).toBe(3);
      expect(await tableExists(db, 'probe_two')).toBe(true);
      expect(await tableExists(db, 'probe_three')).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'rolls back a failed migration and leaves schema_version untouched',
    async () => {
      db = new PGlite();
      await migrate(db);

      const broken: Migration = {
        version: 2,
        name: 'broken',
        sql: 'CREATE TABLE rollback_probe (id INTEGER PRIMARY KEY); SELECT * FROM not_a_table;',
      };

      await expect(migrate(db, [BASELINE, broken])).rejects.toThrowError(MigrationError);
      await expect(migrate(db, [BASELINE, broken])).rejects.toThrowError(/migration 2 \(broken\)/);

      // Transaction rolled back: neither the table nor the version row survived.
      expect(await tableExists(db, 'rollback_probe')).toBe(false);
      const status = await migrationStatus(db);
      expect(status.current).toBe(1);

      // A corrected migration with the same version then applies cleanly.
      const fixed = probeMigration(2, 'rollback_probe_fixed');
      const result = await migrate(db, [BASELINE, fixed]);
      expect(result.applied).toEqual([2]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'refuses to run against a schema newer than the registry',
    async () => {
      db = new PGlite();
      await migrate(db);
      await db.query(`INSERT INTO schema_version (version, name) VALUES (99, 'from-the-future')`);

      await expect(migrate(db)).rejects.toThrowError(/newer than this daemon/);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'rejects malformed registries before touching the database',
    async () => {
      db = new PGlite();

      const duplicate = [BASELINE, probeMigration(1, 'dup')];
      await expect(migrate(db, duplicate)).rejects.toThrowError(/unique and ascending/);

      const descending = [probeMigration(2, 'two'), probeMigration(1, 'one')];
      await expect(migrate(db, descending)).rejects.toThrowError(/unique and ascending/);

      const nonInteger = [{ version: 1.5, name: 'half', sql: 'SELECT 1;' }];
      await expect(migrate(db, nonInteger)).rejects.toThrowError(/positive integers/);

      const empty = [{ version: 1, name: ' ', sql: 'SELECT 1;' }];
      await expect(migrate(db, empty)).rejects.toThrowError(/empty name or empty sql/);
    },
    DB_TEST_TIMEOUT,
  );
});

describe('migrationStatus()', () => {
  let db: PGlite;

  afterEach(async () => {
    await db.close().catch(() => {});
  });

  it(
    'reports current 0 with the baseline pending, then no pending once applied',
    async () => {
      db = new PGlite();

      const before = await migrationStatus(db);
      expect(before.current).toBe(0);
      expect(before.latest).toBe(1);
      expect(before.pending).toEqual([{ version: 1, name: 'initial-schema' }]);

      await migrate(db);

      const after = await migrationStatus(db);
      expect(after.current).toBe(1);
      expect(after.pending).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );
});

describe('startDaemon() migration wiring', () => {
  it(
    'boots a fresh data dir through the migration runner',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'revdev-mig-'));
      const socketPath = join(dir, 'mig.sock');
      const d = await startDaemon({ socketPath, dataDir: join(dir, 'db'), pruneIntervalMs: 0 });
      try {
        const rows = await d._db.query<{ version: number }>(
          'SELECT version FROM schema_version ORDER BY version',
        );
        expect(rows.rows).toEqual([{ version: 1 }]);
      } finally {
        await d.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT,
  );
});
