/**
 * goal.* RPCs are Pro-floor (default requiredTier). Enterprise ranks above Pro,
 * so founder enterprise JWTs unlock the goal spine without a separate allowlist.
 */
import { describe, expect, it } from 'vitest';
import { LICENSE_TIER_HELP, requiredTier, tierRank } from '../license.js';

const GOAL_METHODS = [
  'goal.create',
  'goal.get',
  'goal.list',
  'goal.setStatus',
  'goal.progress',
  'goal.nextActions',
  'goal.proposeTask',
] as const;

describe('goal.* license floor', () => {
  it('defaults every goal.* method to pro', () => {
    for (const m of GOAL_METHODS) {
      expect(requiredTier(m)).toBe('pro');
    }
  });

  it('enterprise and max satisfy the pro floor', () => {
    const need = tierRank('pro');
    expect(tierRank('enterprise')).toBeGreaterThanOrEqual(need);
    expect(tierRank('max')).toBeGreaterThanOrEqual(need);
    expect(tierRank('pro')).toBeGreaterThanOrEqual(need);
    expect(tierRank('free')).toBeLessThan(need);
  });

  it('LICENSE_TIER_HELP documents goal.* under pro', () => {
    expect(LICENSE_TIER_HELP).toMatch(/goal\.\*/);
  });
});
