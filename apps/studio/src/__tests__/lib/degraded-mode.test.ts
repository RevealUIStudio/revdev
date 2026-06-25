import { afterEach, describe, expect, it } from 'vitest';
import { __resetDegradedModeForTests, isDegradedMode, markDegraded } from '../../lib/degraded-mode';

type Win = Record<string, unknown>;

function setTauri(on: boolean): void {
  if (on) {
    (window as unknown as Win).__TAURI_INTERNALS__ = {};
  } else {
    delete (window as unknown as Win).__TAURI_INTERNALS__;
  }
  __resetDegradedModeForTests();
}

describe('degraded-mode', () => {
  afterEach(() => {
    setTauri(false);
  });

  it('is degraded when not running under Tauri (browser preview)', () => {
    setTauri(false);
    expect(isDegradedMode()).toBe(true);
  });

  it('is not degraded under Tauri until a runtime fallback fires', () => {
    setTauri(true);
    expect(isDegradedMode()).toBe(false);

    markDegraded('mock fired');
    expect(isDegradedMode()).toBe(true);
  });

  it('stays degraded after repeated markDegraded calls', () => {
    setTauri(true);
    markDegraded('reason-a');
    markDegraded('reason-a');
    markDegraded('reason-b');
    expect(isDegradedMode()).toBe(true);
  });
});
