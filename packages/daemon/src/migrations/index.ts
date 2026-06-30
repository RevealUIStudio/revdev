/**
 * Migration registry — the ordered list of every schema migration this
 * daemon build knows about.
 *
 * Adding a schema change:
 *   1. Create `src/migrations/000N-<kebab-name>.ts` exporting a
 *      `Migration` with the next version number.
 *   2. Append it to MIGRATIONS below (ascending order — the runner
 *      validates and refuses out-of-order or duplicate versions).
 *   3. Never edit an already-shipped migration; ship a corrective
 *      migration instead.
 *
 * Migrations are TS modules (not .sql files) deliberately: tsup bundles
 * the daemon, and files loaded from disk at runtime do not survive the
 * bundle (they would need a postbuild copy step that drifts).
 */

import type { Migration } from '../storage/migrate.js';
import { MIGRATION_0001 } from './0001-initial-schema.js';
import { MIGRATION_0002 } from './0002-key-origin.js';
import { MIGRATION_0003 } from './0003-project-roots.js';
import { MIGRATION_0004 } from './0004-agent-processes.js';
import { MIGRATION_0005 } from './0005-session-activity-state.js';

export const MIGRATIONS: readonly Migration[] = [
  MIGRATION_0001,
  MIGRATION_0002,
  MIGRATION_0003,
  MIGRATION_0004,
  MIGRATION_0005,
];
