import { describe, expect, it } from 'vitest';
import { guardSelectOnly } from '../guard.js';

describe('guardSelectOnly allows a single read', () => {
  it('allows a single SELECT', () => {
    const decision = guardSelectOnly('SELECT 1');
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.statement).toBe('SELECT 1');
  });

  it('allows a lowercase SELECT with whitespace', () => {
    const decision = guardSelectOnly('  select id\nfrom accounts  ');
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.statement).toContain('select id');
  });

  it('allows WITH ... SELECT', () => {
    const decision = guardSelectOnly('WITH c AS (SELECT 1) SELECT * FROM c');
    expect(decision.ok).toBe(true);
  });

  it('allows WITH RECURSIVE ... SELECT', () => {
    const sql =
      'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT * FROM c';
    expect(guardSelectOnly(sql).ok).toBe(true);
  });

  it('allows WITH MATERIALIZED and a second CTE', () => {
    const sql = 'WITH c AS MATERIALIZED (SELECT 1), d AS (SELECT 2) SELECT * FROM c JOIN d ON true';
    expect(guardSelectOnly(sql).ok).toBe(true);
  });

  it('allows UNION of two SELECTs in one statement', () => {
    expect(guardSelectOnly('SELECT 1 UNION SELECT 2').ok).toBe(true);
  });

  it('allows CASE WHEN THEN ELSE END', () => {
    expect(guardSelectOnly('SELECT CASE WHEN kind = 1 THEN 1 ELSE 0 END FROM t').ok).toBe(true);
  });

  it('allows a write keyword inside a string literal', () => {
    const decision = guardSelectOnly("SELECT 'DELETE FROM accounts'");
    expect(decision.ok).toBe(true);
  });

  it('allows a semicolon inside a dollar quote', () => {
    expect(guardSelectOnly('SELECT $$ ; $$').ok).toBe(true);
  });

  it('allows one trailing semicolon', () => {
    const decision = guardSelectOnly('SELECT 1;');
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.statement).toBe('SELECT 1');
  });

  it('allows a benign block comment and strips it from the statement', () => {
    const decision = guardSelectOnly('SELECT 1 /* count */');
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.statement).toBe('SELECT 1');
      expect(decision.statement.includes('/*')).toBe(false);
    }
  });
});

describe('guardSelectOnly rejects writes, DDL, and hidden writes', () => {
  it('rejects INSERT', () => {
    const decision = guardSelectOnly('INSERT INTO accounts (id) VALUES (1)');
    expect(decision).toEqual({ ok: false, reason: 'INSERT is not allowed' });
  });

  it('rejects UPDATE', () => {
    expect(guardSelectOnly('UPDATE accounts SET name = name')).toEqual({
      ok: false,
      reason: 'UPDATE is not allowed',
    });
  });

  it('rejects DELETE', () => {
    expect(guardSelectOnly('DELETE FROM accounts')).toEqual({
      ok: false,
      reason: 'DELETE is not allowed',
    });
  });

  it('rejects SELECT ... FOR UPDATE', () => {
    expect(guardSelectOnly('SELECT id FROM accounts FOR UPDATE')).toEqual({
      ok: false,
      reason: 'UPDATE is not allowed',
    });
  });

  it('rejects a data-modifying CTE', () => {
    expect(guardSelectOnly('WITH c AS (DELETE FROM accounts RETURNING *) SELECT * FROM c')).toEqual(
      { ok: false, reason: 'DELETE is not allowed' },
    );
  });

  it('rejects SELECT INTO', () => {
    expect(guardSelectOnly('SELECT * INTO copy FROM accounts')).toEqual({
      ok: false,
      reason: 'SELECT INTO is not allowed',
    });
  });

  it('rejects SELECT INTO TEMP', () => {
    expect(guardSelectOnly('SELECT * INTO TEMP copy FROM accounts')).toEqual({
      ok: false,
      reason: 'SELECT INTO is not allowed',
    });
  });

  it('rejects DROP', () => {
    expect(guardSelectOnly('DROP TABLE accounts')).toEqual({
      ok: false,
      reason: 'DDL is not allowed (DROP)',
    });
  });

  it('rejects CREATE', () => {
    expect(guardSelectOnly('CREATE TABLE accounts (id int)')).toEqual({
      ok: false,
      reason: 'DDL is not allowed (CREATE)',
    });
  });

  it('rejects ALTER', () => {
    expect(guardSelectOnly('ALTER TABLE accounts ADD COLUMN n int')).toEqual({
      ok: false,
      reason: 'DDL is not allowed (ALTER)',
    });
  });

  it('rejects TRUNCATE', () => {
    expect(guardSelectOnly('TRUNCATE accounts')).toEqual({
      ok: false,
      reason: 'DDL is not allowed (TRUNCATE)',
    });
  });

  it('rejects GRANT', () => {
    expect(guardSelectOnly('GRANT SELECT ON accounts TO someone')).toEqual({
      ok: false,
      reason: 'DDL is not allowed (GRANT)',
    });
  });

  it('rejects COPY', () => {
    expect(guardSelectOnly('COPY accounts TO STDOUT')).toEqual({
      ok: false,
      reason: 'COPY is not allowed',
    });
  });

  it('rejects a second statement', () => {
    expect(guardSelectOnly('SELECT 1; SELECT 2')).toEqual({
      ok: false,
      reason: 'multiple statements are not allowed',
    });
  });

  it('rejects a write hidden after a semicolon', () => {
    expect(guardSelectOnly('SELECT 1; DROP TABLE accounts')).toEqual({
      ok: false,
      reason: 'multiple statements are not allowed',
    });
  });

  it('rejects an empty statement between semicolons', () => {
    expect(guardSelectOnly('SELECT 1;;')).toEqual({
      ok: false,
      reason: 'multiple statements are not allowed',
    });
  });

  it('rejects a line comment that hides a write', () => {
    expect(guardSelectOnly('SELECT 1 -- DROP TABLE accounts')).toEqual({
      ok: false,
      reason: 'comment hides a write',
    });
  });

  it('rejects a line comment even when the visible text is a SELECT', () => {
    expect(guardSelectOnly('SELECT 1 -- note')).toEqual({
      ok: false,
      reason: 'comment hides a write',
    });
  });

  it('rejects a block comment that contains a write', () => {
    expect(guardSelectOnly('SELECT 1 /* DELETE FROM accounts */')).toEqual({
      ok: false,
      reason: 'comment hides a write',
    });
  });

  it('rejects a block comment that hides a statement break', () => {
    expect(guardSelectOnly('SELECT 1 /* ; DROP TABLE accounts */')).toEqual({
      ok: false,
      reason: 'comment hides a write',
    });
  });

  it('rejects a leading block comment that contains DDL', () => {
    expect(guardSelectOnly('/* DROP */ SELECT 1')).toEqual({
      ok: false,
      reason: 'comment hides a write',
    });
  });

  it('rejects an unterminated block comment', () => {
    expect(guardSelectOnly('SELECT 1 /*')).toEqual({
      ok: false,
      reason: 'unterminated block comment',
    });
  });

  it('rejects unbalanced parentheses that could escape a wrapper', () => {
    expect(guardSelectOnly('SELECT 1) UNION SELECT 2')).toEqual({
      ok: false,
      reason: 'unbalanced parentheses',
    });
  });

  it('rejects EXPLAIN', () => {
    expect(guardSelectOnly('EXPLAIN SELECT 1')).toEqual({
      ok: false,
      reason: 'EXPLAIN is not allowed',
    });
  });

  it('rejects an empty query', () => {
    expect(guardSelectOnly('   ')).toEqual({ ok: false, reason: 'empty query' });
  });

  it('rejects bound parameters so the wrapper owns $1', () => {
    expect(guardSelectOnly('SELECT id FROM accounts WHERE id = $1')).toEqual({
      ok: false,
      reason: 'bound parameters are not allowed',
    });
  });
});
