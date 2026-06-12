/**
 * Storage layer — PGlite-backed daemon state.
 */

export { MIGRATIONS } from '../migrations/index.js';
export {
  type Migration,
  MigrationError,
  type MigrationStatus,
  migrate,
  migrationStatus,
} from './migrate.js';
export { SCHEMA_SQL } from './schema.js';
