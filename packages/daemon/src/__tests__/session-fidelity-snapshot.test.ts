/**
 * GAP-342 — fidelity section shape + retention helper.
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  emptyFidelitySections,
  FIDELITY_SECTION_KEYS,
  normalizeFidelitySections,
  retentionCutoffIso,
  SNAPSHOT_RETENTION_DAYS,
} from '../session-fidelity-snapshot.js';

describe('normalizeFidelitySections', () => {
  it('requires an object', () => {
    expect(() => normalizeFidelitySections(null)).toThrow(/object/);
    expect(() => normalizeFidelitySections('x')).toThrow(/object/);
  });

  it('requires at least one non-empty section', () => {
    expect(() => normalizeFidelitySections({})).toThrow(/non-empty/);
    expect(() => normalizeFidelitySections(emptyFidelitySections())).toThrow(/non-empty/);
  });

  it('fills missing keys with empty strings and keeps known content', () => {
    const s = normalizeFidelitySections({
      resumeFromHere: 'continue at GAP-342',
      whatShipped: 'handlers',
    });
    expect(s.resumeFromHere).toBe('continue at GAP-342');
    expect(s.whatShipped).toBe('handlers');
    expect(s.activeConstraints).toBe('');
    expect(s.doNotRepeat).toBe('');
    expect(s.openLooseEnds).toBe('');
    expect(FIDELITY_SECTION_KEYS).toHaveLength(5);
  });

  it('rejects non-string section values', () => {
    expect(() => normalizeFidelitySections({ resumeFromHere: 12 as unknown as string })).toThrow(
      /string/,
    );
  });
});

describe('retentionCutoffIso', () => {
  it('defaults to SNAPSHOT_RETENTION_DAYS and is earlier than now', () => {
    const now = new Date('2026-08-07T12:00:00.000Z');
    const cut = retentionCutoffIso(now);
    expect(SNAPSHOT_RETENTION_DAYS).toBe(7);
    expect(new Date(cut).getTime()).toBe(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  });

  it('rejects non-positive maxAgeDays', () => {
    expect(() => retentionCutoffIso(new Date(), 0)).toThrow(/positive/);
  });
});
