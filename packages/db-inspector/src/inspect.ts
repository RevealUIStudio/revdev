/**
 * Inspector query wrapper. Row limit and statement timeout are bound
 * parameters, not interpolated. One audit receipt per query. The readonly
 * URL is read from DATABASE_URL_READONLY; a missing value throws before
 * connect. This module never opens a driver itself.
 */

import { guardSelectOnly } from './guard.js';

export const READONLY_DATABASE_ENV = 'DATABASE_URL_READONLY';
export const READONLY_DATABASE_VAULT_PATH = 'revealui/prod/db/postgres-url-readonly';

export const MIN_ROW_LIMIT = 1;
export const MAX_ROW_LIMIT = 1000;
export const MIN_STATEMENT_TIMEOUT_MS = 1;
export const MAX_STATEMENT_TIMEOUT_MS = 15_000;

export const BEGIN_READ_ONLY_SQL = 'BEGIN READ ONLY';
export const COMMIT_SQL = 'COMMIT';
export const ROLLBACK_SQL = 'ROLLBACK';
export const STATEMENT_TIMEOUT_SQL = "SELECT set_config('statement_timeout', $1, true)";

export class ReadonlyDatabaseUrlError extends Error {
  readonly code = 'DATABASE_URL_READONLY_MISSING';

  constructor() {
    super(
      `${READONLY_DATABASE_ENV} is not set. The inspector refuses to connect. Vault the SELECT-only URL at ${READONLY_DATABASE_VAULT_PATH}.`,
    );
    this.name = 'ReadonlyDatabaseUrlError';
  }
}

export interface SqlStep {
  text: string;
  params: readonly unknown[];
}

export interface SqlExecutor {
  execute(step: SqlStep): Promise<{ rows: readonly unknown[] }>;
}

export interface AuditReceipt {
  id: string;
  at: string;
  outcome: 'rejected' | 'completed' | 'failed';
  reason: string | null;
  statementPreview: string;
  rowLimit: number | null;
  statementTimeoutMs: number | null;
  rowCount: number | null;
}

export type InspectResult =
  | { ok: true; rows: readonly unknown[]; receipt: AuditReceipt }
  | { ok: false; receipt: AuditReceipt };

export interface RunInspectInput {
  sql: string;
  rowLimit: number;
  statementTimeoutMs: number;
  executor: SqlExecutor;
  audit: (receipt: AuditReceipt) => void;
  now?: () => string;
  createId?: () => string;
}

export interface InspectReadonlyInput {
  sql: string;
  rowLimit: number;
  statementTimeoutMs: number;
  env: Readonly<Record<string, string | undefined>>;
  connect: (url: string) => Promise<SqlExecutor>;
  audit: (receipt: AuditReceipt) => void;
  now?: () => string;
  createId?: () => string;
}

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!cryptoApi?.randomUUID) throw new Error('crypto.randomUUID is unavailable');
  return cryptoApi.randomUUID();
}

function statementPreview(sql: string): string {
  const trimmed = sql.trim();
  if (trimmed.length <= 200) return trimmed;
  return `${trimmed.slice(0, 200)}…`;
}

function isBoundedInt(value: number, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function limitReason(rowLimit: number, statementTimeoutMs: number): string | null {
  if (!isBoundedInt(rowLimit, MIN_ROW_LIMIT, MAX_ROW_LIMIT)) {
    return `rowLimit must be an integer from ${MIN_ROW_LIMIT} to ${MAX_ROW_LIMIT}`;
  }
  if (!isBoundedInt(statementTimeoutMs, MIN_STATEMENT_TIMEOUT_MS, MAX_STATEMENT_TIMEOUT_MS)) {
    return `statementTimeoutMs must be an integer from ${MIN_STATEMENT_TIMEOUT_MS} to ${MAX_STATEMENT_TIMEOUT_MS}`;
  }
  return null;
}

export function requireReadonlyDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const raw = env[READONLY_DATABASE_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') throw new ReadonlyDatabaseUrlError();
  return raw.trim();
}

export async function openReadonlyInspector(deps: {
  env: Readonly<Record<string, string | undefined>>;
  connect: (url: string) => Promise<SqlExecutor>;
}): Promise<SqlExecutor> {
  const url = requireReadonlyDatabaseUrl(deps.env);
  return deps.connect(url);
}

function wrappedSelect(statement: string): string {
  return `SELECT * FROM (${statement}) AS inspector_rows LIMIT $1`;
}

function safeErrorReason(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const message = err.message;
  const lower = message.toLowerCase();
  if (message.includes('://') || message.includes('@') || lower.includes('password')) {
    return fallback;
  }
  return message;
}

function makeReceipt(
  input: {
    sql: string;
    rowLimit: number;
    statementTimeoutMs: number;
    now?: () => string;
    createId?: () => string;
  },
  fields: {
    outcome: AuditReceipt['outcome'];
    reason: string | null;
    rowCount: number | null;
    keepLimits: boolean;
  },
): AuditReceipt {
  return {
    id: (input.createId ?? defaultId)(),
    at: (input.now ?? defaultNow)(),
    outcome: fields.outcome,
    reason: fields.reason,
    statementPreview: statementPreview(input.sql),
    rowLimit: fields.keepLimits ? input.rowLimit : null,
    statementTimeoutMs: fields.keepLimits ? input.statementTimeoutMs : null,
    rowCount: fields.rowCount,
  };
}

export async function runInspectQuery(input: RunInspectInput): Promise<InspectResult> {
  const invalid = limitReason(input.rowLimit, input.statementTimeoutMs);
  if (invalid !== null) {
    const receipt = makeReceipt(input, {
      outcome: 'rejected',
      reason: invalid,
      rowCount: null,
      keepLimits: false,
    });
    input.audit(receipt);
    return { ok: false, receipt };
  }

  const guarded = guardSelectOnly(input.sql);
  if (!guarded.ok) {
    const receipt = makeReceipt(input, {
      outcome: 'rejected',
      reason: guarded.reason,
      rowCount: null,
      keepLimits: true,
    });
    input.audit(receipt);
    return { ok: false, receipt };
  }

  const timeoutStep: SqlStep = {
    text: STATEMENT_TIMEOUT_SQL,
    params: [String(input.statementTimeoutMs)],
  };
  const queryStep: SqlStep = {
    text: wrappedSelect(guarded.statement),
    params: [input.rowLimit],
  };

  let began = false;
  let emitted = false;
  try {
    await input.executor.execute({ text: BEGIN_READ_ONLY_SQL, params: [] });
    began = true;
    await input.executor.execute(timeoutStep);
    const result = await input.executor.execute(queryStep);
    if (!Array.isArray(result.rows)) throw new Error('query failed');
    await input.executor.execute({ text: COMMIT_SQL, params: [] });
    const rows = result.rows.slice(0, input.rowLimit);
    const receipt = makeReceipt(input, {
      outcome: 'completed',
      reason: null,
      rowCount: rows.length,
      keepLimits: true,
    });
    emitted = true;
    input.audit(receipt);
    return { ok: true, rows, receipt };
  } catch (err) {
    if (emitted) throw err;
    if (began) {
      try {
        await input.executor.execute({ text: ROLLBACK_SQL, params: [] });
      } catch {
        // One receipt for the query. Rollback failure does not add another.
      }
    }
    const receipt = makeReceipt(input, {
      outcome: 'failed',
      reason: safeErrorReason(err, 'query failed'),
      rowCount: null,
      keepLimits: true,
    });
    input.audit(receipt);
    return { ok: false, receipt };
  }
}

export async function inspectReadonly(input: InspectReadonlyInput): Promise<InspectResult> {
  const url = requireReadonlyDatabaseUrl(input.env);
  const invalid = limitReason(input.rowLimit, input.statementTimeoutMs);
  if (invalid !== null) {
    const receipt = makeReceipt(input, {
      outcome: 'rejected',
      reason: invalid,
      rowCount: null,
      keepLimits: false,
    });
    input.audit(receipt);
    return { ok: false, receipt };
  }
  const guarded = guardSelectOnly(input.sql);
  if (!guarded.ok) {
    const receipt = makeReceipt(input, {
      outcome: 'rejected',
      reason: guarded.reason,
      rowCount: null,
      keepLimits: true,
    });
    input.audit(receipt);
    return { ok: false, receipt };
  }

  let executor: SqlExecutor;
  try {
    executor = await input.connect(url);
  } catch (err) {
    const receipt = makeReceipt(input, {
      outcome: 'failed',
      reason: safeErrorReason(err, 'failed to connect'),
      rowCount: null,
      keepLimits: true,
    });
    input.audit(receipt);
    return { ok: false, receipt };
  }

  return runInspectQuery({
    sql: input.sql,
    rowLimit: input.rowLimit,
    statementTimeoutMs: input.statementTimeoutMs,
    executor,
    audit: input.audit,
    ...(input.now ? { now: input.now } : {}),
    ...(input.createId ? { createId: input.createId } : {}),
  });
}
