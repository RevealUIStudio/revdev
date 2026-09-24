/**
 * Barrel wiring for runtime exports (type-only re-exports are erased at
 * compile time, so tsc's own build already proves those bindings resolve).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOOP_NOOP_LIMIT,
  LOOP_GUARD_METHODS,
  loopMustStop,
  RPC_METHODS,
} from '../index.js';
import { DEFAULT_LOOP_NOOP_LIMIT as DEFAULT_DIRECT } from '../loop-contract.js';
import { RPC_METHODS as RPC_METHODS_DIRECT } from '../methods.js';

describe('index barrel', () => {
  it('re-exports RPC_METHODS unchanged', () => {
    expect(RPC_METHODS).toBe(RPC_METHODS_DIRECT);
  });

  it('re-exports the loop guard contract', () => {
    expect(DEFAULT_LOOP_NOOP_LIMIT).toBe(DEFAULT_DIRECT);
    expect(DEFAULT_LOOP_NOOP_LIMIT).toBe(3);
    expect(LOOP_GUARD_METHODS.tick).toBe(RPC_METHODS['loop.tick']);
    expect(loopMustStop('not_advancing')).toBe(true);
  });
});
