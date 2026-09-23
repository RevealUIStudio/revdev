import { describe, expect, it, vi } from 'vitest';
import {
  type AuditReceipt,
  BEGIN_READ_ONLY_SQL,
  COMMIT_SQL,
  inspectReadonly,
  openReadonlyInspector,
  READONLY_DATABASE_ENV,
  READONLY_DATABASE_VAULT_PATH,
  ReadonlyDatabaseUrlError,
  ROLLBACK_SQL,
  runInspectQuery,
  type SqlExecutor,
  type SqlStep,
  STATEMENT_TIMEOUT_SQL,
} from '../index.js';

function clock(): { now: () => string; createId: () => string } {
  return {
    now: () => '2026-09-23T00:00:00.000Z',
    createId: () => 'receipt-1',
  };
}

function recordingExecutor(rows: readonly unknown[] = [{ id: 'row' }]): {
  calls: SqlStep[];
  executor: SqlExecutor;
} {
  const calls: SqlStep[] = [];
  return {
    calls,
    executor: {
      execute: async (step) => {
        calls.push(step);
        if (step.text.includes('inspector_rows')) return { rows };
        return { rows: [] };
      },
    },
  };
}

describe('runInspectQuery wrapper', () => {
  it('binds the row limit and statement timeout as parameters and writes one receipt', async () => {
    const { calls, executor } = recordingExecutor([{ id: 'a' }, { id: 'b' }]);
    const receipts: AuditReceipt[] = [];
    const result = await runInspectQuery({
      sql: 'SELECT id FROM accounts',
      rowLimit: 17,
      statementTimeoutMs: 2345,
      executor,
      audit: (receipt) => receipts.push(receipt),
      ...clock(),
    });

    expect(result.ok).toBe(true);
    expect(calls.map((step) => step.text)).toEqual([
      BEGIN_READ_ONLY_SQL,
      STATEMENT_TIMEOUT_SQL,
      'SELECT * FROM (SELECT id FROM accounts) AS inspector_rows LIMIT $1',
      COMMIT_SQL,
    ]);
    const timeout = calls[1];
    const query = calls[2];
    expect(timeout?.params).toEqual(['2345']);
    expect(timeout?.text.includes('2345')).toBe(false);
    expect(query?.params).toEqual([17]);
    expect(query?.text.includes('17')).toBe(false);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual({
      id: 'receipt-1',
      at: '2026-09-23T00:00:00.000Z',
      outcome: 'completed',
      reason: null,
      statementPreview: 'SELECT id FROM accounts',
      rowLimit: 17,
      statementTimeoutMs: 2345,
      rowCount: 2,
    });
  });

  it('caps rows returned by the executor at the row limit', async () => {
    const { executor } = recordingExecutor([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const receipts: AuditReceipt[] = [];
    const result = await runInspectQuery({
      sql: 'SELECT n FROM items',
      rowLimit: 2,
      statementTimeoutMs: 1000,
      executor,
      audit: (receipt) => receipts.push(receipt),
      ...clock(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toEqual([{ n: 1 }, { n: 2 }]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.rowCount).toBe(2);
  });

  it('strips a benign block comment before wrapping so it cannot hide the limit', async () => {
    const { calls, executor } = recordingExecutor();
    await runInspectQuery({
      sql: 'SELECT 1 /* note */',
      rowLimit: 10,
      statementTimeoutMs: 1000,
      executor,
      audit: () => undefined,
      ...clock(),
    });
    const query = calls[2];
    expect(query?.text).toBe('SELECT * FROM (SELECT 1) AS inspector_rows LIMIT $1');
    expect(query?.text.includes('/*')).toBe(false);
  });

  it('does not call the executor when the guard rejects, and writes one receipt', async () => {
    const { calls, executor } = recordingExecutor();
    const receipts: AuditReceipt[] = [];
    const result = await runInspectQuery({
      sql: 'DELETE FROM accounts',
      rowLimit: 10,
      statementTimeoutMs: 1000,
      executor,
      audit: (receipt) => receipts.push(receipt),
      ...clock(),
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe('rejected');
    expect(receipts[0]?.reason).toBe('DELETE is not allowed');
  });

  it('rejects a zero row limit before executing', async () => {
    const { calls, executor } = recordingExecutor();
    const receipts: AuditReceipt[] = [];
    const result = await runInspectQuery({
      sql: 'SELECT 1',
      rowLimit: 0,
      statementTimeoutMs: 1000,
      executor,
      audit: (receipt) => receipts.push(receipt),
      ...clock(),
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.reason).toMatch(/rowLimit/);
  });

  it('rejects a zero statement timeout so the timeout cannot be disabled', async () => {
    const { calls, executor } = recordingExecutor();
    const receipts: AuditReceipt[] = [];
    const result = await runInspectQuery({
      sql: 'SELECT 1',
      rowLimit: 10,
      statementTimeoutMs: 0,
      executor,
      audit: (receipt) => receipts.push(receipt),
      ...clock(),
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.reason).toMatch(/statementTimeoutMs/);
  });

  it('writes one failed receipt and rolls back when the query step throws', async () => {
    const calls: SqlStep[] = [];
    const executor: SqlExecutor = {
      execute: async (step) => {
        calls.push(step);
        if (step.text.includes('inspector_rows')) throw new Error('boom');
        return { rows: [] };
      },
    };
    const receipts: AuditReceipt[] = [];
    const result = await runInspectQuery({
      sql: 'SELECT 1',
      rowLimit: 10,
      statementTimeoutMs: 1000,
      executor,
      audit: (receipt) => receipts.push(receipt),
      ...clock(),
    });
    expect(result.ok).toBe(false);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe('failed');
    expect(receipts[0]?.reason).toBe('boom');
    expect(calls.some((step) => step.text === ROLLBACK_SQL)).toBe(true);
    expect(calls.some((step) => step.text === COMMIT_SQL)).toBe(false);
  });

  it('redacts a driver message that contains a scheme marker', async () => {
    const executor: SqlExecutor = {
      execute: async (step) => {
        if (step.text.includes('inspector_rows'))
          throw new Error('driver returned :// in the failure');
        return { rows: [] };
      },
    };
    const receipts: AuditReceipt[] = [];
    await runInspectQuery({
      sql: 'SELECT 1',
      rowLimit: 10,
      statementTimeoutMs: 1000,
      executor,
      audit: (receipt) => receipts.push(receipt),
      ...clock(),
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.reason).toBe('query failed');
    expect(receipts[0]?.reason?.includes('://')).toBe(false);
  });
});

describe('DATABASE_URL_READONLY', () => {
  it('returns a clear error and does not connect when the env var is missing', async () => {
    const connect = vi.fn();
    const audit = vi.fn();
    await expect(
      inspectReadonly({
        sql: 'SELECT 1',
        rowLimit: 10,
        statementTimeoutMs: 1000,
        env: {},
        connect,
        audit,
      }),
    ).rejects.toBeInstanceOf(ReadonlyDatabaseUrlError);
    await expect(
      inspectReadonly({
        sql: 'SELECT 1',
        rowLimit: 10,
        statementTimeoutMs: 1000,
        env: {},
        connect,
        audit,
      }),
    ).rejects.toThrow(
      new RegExp(`${READONLY_DATABASE_ENV}[\\s\\S]*${READONLY_DATABASE_VAULT_PATH}`),
    );
    expect(connect).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('does not connect when the env var is blank', async () => {
    const connect = vi.fn();
    await expect(
      openReadonlyInspector({
        env: { [READONLY_DATABASE_ENV]: '   ' },
        connect,
      }),
    ).rejects.toThrow(/refuses to connect/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not connect when the env var is absent and other env keys are set', async () => {
    const connect = vi.fn();
    await expect(
      openReadonlyInspector({
        env: { PATH: '/usr/bin' },
        connect,
      }),
    ).rejects.toBeInstanceOf(ReadonlyDatabaseUrlError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not connect when the statement is rejected', async () => {
    const connect = vi.fn();
    const receipts: AuditReceipt[] = [];
    const result = await inspectReadonly({
      sql: 'DELETE FROM accounts',
      rowLimit: 10,
      statementTimeoutMs: 1000,
      env: { [READONLY_DATABASE_ENV]: 'configured' },
      connect,
      audit: (receipt) => receipts.push(receipt),
      ...clock(),
    });
    expect(result.ok).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe('rejected');
  });

  it('writes one receipt and redacts a connect failure that contains a scheme marker', async () => {
    const connect = vi.fn(async () => {
      throw new Error('connect failed with :// in the driver text');
    });
    const receipts: AuditReceipt[] = [];
    const result = await inspectReadonly({
      sql: 'SELECT 1',
      rowLimit: 10,
      statementTimeoutMs: 1000,
      env: { [READONLY_DATABASE_ENV]: 'configured' },
      connect,
      audit: (receipt) => receipts.push(receipt),
      ...clock(),
    });
    expect(result.ok).toBe(false);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.reason).toBe('failed to connect');
    expect(JSON.stringify(receipts).includes('://')).toBe(false);
  });
});
