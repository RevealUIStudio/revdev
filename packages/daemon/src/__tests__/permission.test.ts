/**
 * GAP-294 Phase 0 — action-class map + shadow evaluation.
 */
import { RPC_METHODS } from '@revdev/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyMethod,
  evaluateShadow,
  expectedClassifiedMethods,
  METHOD_ACTION_CLASS,
  shadowWouldAuto,
  shadowWouldManual,
} from '../permission.js';

describe('METHOD_ACTION_CLASS coverage', () => {
  it('classifies every RPC_METHODS value', () => {
    for (const method of Object.values(RPC_METHODS)) {
      expect(
        METHOD_ACTION_CLASS.has(method),
        `RPC method ${method} missing from METHOD_ACTION_CLASS`,
      ).toBe(true);
    }
  });

  it('classifies expectedClassifiedMethods without gaps for protocol set', () => {
    const expected = new Set(expectedClassifiedMethods());
    for (const method of Object.values(RPC_METHODS)) {
      expect(expected.has(method)).toBe(true);
    }
  });

  it('unmapped method fails closed to critical', () => {
    expect(classifyMethod('totally.unknown.method')).toBe('critical');
  });
});

describe('shadow would (manual simulation)', () => {
  it('routine allows', () => {
    expect(shadowWouldManual('routine')).toBe('allow');
  });
  it('consequential and critical require approval', () => {
    expect(shadowWouldManual('consequential')).toBe('require_approval');
    expect(shadowWouldManual('critical')).toBe('require_approval');
  });
});

describe('shadow would (auto simulation)', () => {
  it('routine and consequential allow; critical requires approval', () => {
    expect(shadowWouldAuto('routine')).toBe('allow');
    expect(shadowWouldAuto('consequential')).toBe('allow');
    expect(shadowWouldAuto('critical')).toBe('require_approval');
  });
});

describe('evaluateShadow', () => {
  afterEach(() => {
    delete process.env.REVDEV_PERMISSION_SHADOW_AS;
  });

  it('ping is routine would_allow under default manual shadow-as', () => {
    const r = evaluateShadow('ping');
    expect(r.actionClass).toBe('routine');
    expect(r.would).toBe('allow');
    expect(r.eventType).toBe('permission.would_allow');
  });

  it('git.push is critical would_require_approval under manual shadow-as', () => {
    process.env.REVDEV_PERMISSION_SHADOW_AS = 'manual';
    const r = evaluateShadow('git.push');
    expect(r.actionClass).toBe('critical');
    expect(r.would).toBe('require_approval');
    expect(r.eventType).toBe('permission.would_require_approval');
  });

  it('file.write is consequential allow under auto shadow-as', () => {
    process.env.REVDEV_PERMISSION_SHADOW_AS = 'auto';
    const r = evaluateShadow('file.write');
    expect(r.actionClass).toBe('consequential');
    expect(r.would).toBe('allow');
    expect(r.eventType).toBe('permission.would_allow');
  });

  it('agent.spawn is critical require_approval even under auto shadow-as', () => {
    process.env.REVDEV_PERMISSION_SHADOW_AS = 'auto';
    const r = evaluateShadow('agent.spawn');
    expect(r.actionClass).toBe('critical');
    expect(r.would).toBe('require_approval');
  });
});

describe('owner-countersigned judgment calls', () => {
  it('git.pull is consequential (not critical)', () => {
    expect(classifyMethod('git.pull')).toBe('consequential');
  });
  it('git.deleteBranch is consequential; git.discardFile is critical', () => {
    expect(classifyMethod('git.deleteBranch')).toBe('consequential');
    expect(classifyMethod('git.discardFile')).toBe('critical');
  });
  it('agent.input is consequential; agent.stop is routine', () => {
    expect(classifyMethod('agent.input')).toBe('consequential');
    expect(classifyMethod('agent.stop')).toBe('routine');
  });
  it('memory.store is routine', () => {
    expect(classifyMethod('memory.store')).toBe('routine');
  });
});
