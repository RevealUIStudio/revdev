/**
 * RPC contract test.
 *
 * `RPC_METHODS` (protocol) and the daemon's handler registry are two lists that
 * historically drifted: the constant declared methods no handler served
 * (harness.list/execute/info/listRunning/syncConfig/diffConfig, session.history)
 * and omitted whole registered surfaces (file.*, git.*, project.*, inference
 * chat/generate, identity.rotate). This test pins them together.
 *
 * Importing `../index.js` registers every handler group in the exact order
 * production startup does, including spawn.js overwriting the agent.js
 * load-order placeholders. After that side effect, `listRegisteredMethods()`
 * reflects the real, post-startup surface.
 */

import { RPC_METHODS } from '@revdev/protocol';
import { describe, expect, it } from 'vitest';
import '../index.js';
import { listRegisteredMethods } from '../server.js';

function sortedDiff(a: string[], b: string[]): { onlyInA: string[]; onlyInB: string[] } {
  const setB = new Set(b);
  const setA = new Set(a);
  return {
    onlyInA: a.filter((m) => !setB.has(m)).sort(),
    onlyInB: b.filter((m) => !setA.has(m)).sort(),
  };
}

describe('RPC contract', () => {
  it('RPC_METHODS exactly equals the daemon handler registry', () => {
    const registered = listRegisteredMethods();
    const declared = [...Object.values(RPC_METHODS)].sort();

    const { onlyInA: registeredButUndeclared, onlyInB: declaredButUnregistered } = sortedDiff(
      registered,
      declared,
    );

    expect(
      { registeredButUndeclared, declaredButUnregistered },
      `RPC_METHODS drifted from the daemon registry.\n` +
        `Registered but missing from RPC_METHODS: ${JSON.stringify(registeredButUndeclared)}\n` +
        `In RPC_METHODS but not registered (phantoms): ${JSON.stringify(declaredButUnregistered)}`,
    ).toEqual({ registeredButUndeclared: [], declaredButUnregistered: [] });

    expect(registered).toEqual(declared);
  });
});
