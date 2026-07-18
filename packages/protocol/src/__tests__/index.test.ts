/**
 * Barrel wiring for the package's one runtime export (everything else `index.ts`
 * re-exports is type-only and erased at compile time, so tsc's own build
 * already proves those bindings resolve; there is no separate runtime
 * assertion to make for them).
 */

import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '../index.js';
import { RPC_METHODS as RPC_METHODS_DIRECT } from '../methods.js';

describe('index barrel', () => {
  it('re-exports RPC_METHODS unchanged', () => {
    expect(RPC_METHODS).toBe(RPC_METHODS_DIRECT);
  });
});
