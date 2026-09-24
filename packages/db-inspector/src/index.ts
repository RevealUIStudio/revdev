/**
 * Native SELECT-only database inspector.
 * No external UI host. One audit receipt per query.
 */

export { type GuardDecision, guardSelectOnly } from './guard.js';
export {
  type AuditReceipt,
  BEGIN_READ_ONLY_SQL,
  COMMIT_SQL,
  type InspectReadonlyInput,
  type InspectResult,
  inspectReadonly,
  MAX_ROW_LIMIT,
  MAX_STATEMENT_TIMEOUT_MS,
  MIN_ROW_LIMIT,
  MIN_STATEMENT_TIMEOUT_MS,
  openReadonlyInspector,
  READONLY_DATABASE_ENV,
  READONLY_DATABASE_VAULT_PATH,
  ReadonlyDatabaseUrlError,
  ROLLBACK_SQL,
  type RunInspectInput,
  requireReadonlyDatabaseUrl,
  runInspectQuery,
  type SqlExecutor,
  type SqlStep,
  STATEMENT_TIMEOUT_SQL,
} from './inspect.js';
