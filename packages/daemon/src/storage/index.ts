/**
 * Storage layer — PGlite-backed daemon state.
 */

export { SCHEMA_SQL } from './schema.js';
export {
  type Migration,
  MigrationError,
  type MigrationStatus,
  migrate,
  migrationStatus,
} from './migrate.js';
export { MIGRATIONS } from '../migrations/index.js';
