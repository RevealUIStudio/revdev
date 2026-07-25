/**
 * RPC_METHODS is a hand-maintained constant map (protocol has no compiler
 * check that a key's string literal matches its value, and JS silently lets
 * two distinct keys collide on the same value). These tests pin the
 * self-consistency invariants that keep it trustworthy for consumers that
 * index into it by key (e.g. `RPC_METHODS['session.register']`) and hand
 * the value straight to the daemon as the wire method name.
 *
 * The cross-check that the daemon actually registers every method this
 * constant declares (and nothing extra) lives in
 * packages/daemon/src/__tests__/rpc-contract.test.ts, which imports the
 * daemon's real handler registry. That test can't live here without an
 * inverted workspace dependency (protocol depending on its own consumer),
 * so it isn't duplicated in this suite.
 */

import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '../methods.js';

describe('RPC_METHODS', () => {
  const entries = Object.entries(RPC_METHODS);

  it('declares at least one method', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('every key is a non-empty string', () => {
    for (const [key] of entries) {
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it('every value is a non-empty string', () => {
    for (const [, value] of entries) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('every key equals its own value', () => {
    for (const [key, value] of entries) {
      expect(value).toBe(key);
    }
  });

  it('has no two keys sharing the same method name', () => {
    const values = entries.map(([, value]) => value);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });
});
