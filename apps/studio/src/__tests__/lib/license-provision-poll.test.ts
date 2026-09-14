import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LicenseProvisionOutcome } from '../../lib/license-provision';
import {
  attachLicensePoll,
  LICENSE_FOCUS_DEBOUNCE_MS,
  LICENSE_IDLE_POLL_MS,
  recordsSuccessfulCurrent,
  shouldRunFocusPoll,
  shouldRunIdlePoll,
} from '../../lib/license-provision-poll';

describe('recordsSuccessfulCurrent', () => {
  it('counts completed /current round-trips, not skips or errors', () => {
    expect(recordsSuccessfulCurrent({ kind: 'provisioned', jti: 'x' })).toBe(true);
    expect(recordsSuccessfulCurrent({ kind: 'wiped', status: 'revoked' })).toBe(true);
    expect(recordsSuccessfulCurrent({ kind: 'unchanged' })).toBe(true);
    expect(recordsSuccessfulCurrent({ kind: 'flag-off' })).toBe(true);
    expect(recordsSuccessfulCurrent({ kind: 'env-override' })).toBe(true);
    expect(recordsSuccessfulCurrent({ kind: 'skipped', reason: 'localMode' })).toBe(false);
    expect(recordsSuccessfulCurrent({ kind: 'error', message: 'x' })).toBe(false);
    expect(recordsSuccessfulCurrent({ kind: 'verify-failed' })).toBe(false);
  });
});

describe('shouldRunIdlePoll (HC13-poll)', () => {
  const t0 = 1_000_000;
  it('does not run before a successful /current (launch path owns first fetch)', () => {
    expect(shouldRunIdlePoll(t0, null)).toBe(false);
  });
  it('does not run before 6h', () => {
    expect(shouldRunIdlePoll(t0 + LICENSE_IDLE_POLL_MS - 1, t0)).toBe(false);
  });
  it('runs at 6h', () => {
    expect(shouldRunIdlePoll(t0 + LICENSE_IDLE_POLL_MS, t0)).toBe(true);
  });
});

describe('shouldRunFocusPoll (HC14-poll)', () => {
  const t0 = 1_000_000;
  it('does not run before a successful /current', () => {
    expect(shouldRunFocusPoll(t0, null)).toBe(false);
  });
  it('does not run within 15 minutes of last success', () => {
    expect(shouldRunFocusPoll(t0 + LICENSE_FOCUS_DEBOUNCE_MS - 1, t0)).toBe(false);
  });
  it('runs at 15 minutes', () => {
    expect(shouldRunFocusPoll(t0 + LICENSE_FOCUS_DEBOUNCE_MS, t0)).toBe(true);
  });
});

describe('attachLicensePoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires idle poll after 6h from last success, not before', async () => {
    const run = vi.fn(async (): Promise<LicenseProvisionOutcome> => ({ kind: 'unchanged' }));
    const poll = attachLicensePoll(run);
    poll.noteSuccess(Date.now());
    await vi.advanceTimersByTimeAsync(LICENSE_IDLE_POLL_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    poll.dispose();
  });

  it('ignores focus within 15 min; runs after debounce', async () => {
    const run = vi.fn(async (): Promise<LicenseProvisionOutcome> => ({ kind: 'unchanged' }));
    const listeners = new Map<string, () => void>();
    const poll = attachLicensePoll(run, {
      addEventListener: (type, listener) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type) => {
        listeners.delete(type);
      },
    });
    poll.noteSuccess(Date.now());
    listeners.get('focus')?.();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LICENSE_FOCUS_DEBOUNCE_MS);
    listeners.get('focus')?.();
    expect(run).toHaveBeenCalledTimes(1);
    listeners.get('online')?.();
    expect(run).toHaveBeenCalledTimes(1);
    poll.dispose();
  });
});
