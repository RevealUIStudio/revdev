import { describe, expect, it } from 'vitest';
import { hasExemptLabel, isForkSafePromotionSkip, parseLabels } from './prove-red-lib.mjs';

// Regression lock for the GAP-393 review remediation
// (https://github.com/RevealUIStudio/revdev/pull/325#issuecomment-5080422951):
// exact-match label semantics, a JSON-array PR_LABELS transport that never
// throws on malformed/absent input, and a promotion-skip predicate that fires
// only for a same-repo test -> main PR and fails closed otherwise.

describe('parseLabels', () => {
  it('parses a JSON array of label names', () => {
    expect(parseLabels('["bug","verify:no-behavior-change"]')).toEqual([
      'bug',
      'verify:no-behavior-change',
    ]);
  });

  it('trims whitespace around each label', () => {
    expect(parseLabels('[" bug ", " verify:no-behavior-change "]')).toEqual([
      'bug',
      'verify:no-behavior-change',
    ]);
  });

  it('returns an empty array for an empty JSON array', () => {
    expect(parseLabels('[]')).toEqual([]);
  });

  it('returns an empty array when PR_LABELS is unset (undefined)', () => {
    expect(parseLabels(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseLabels('')).toEqual([]);
  });

  it('does not throw and returns an empty array on malformed JSON', () => {
    expect(() => parseLabels('not json')).not.toThrow();
    expect(parseLabels('not json')).toEqual([]);
  });

  it('does not throw and returns an empty array on the legacy comma-joined transport', () => {
    // The workflows now send a JSON array (GAP-393 remediation); a plain
    // comma-joined string is not valid JSON and must degrade safely rather
    // than silently mis-parse.
    expect(() => parseLabels('bug,verify:no-behavior-change')).not.toThrow();
    expect(parseLabels('bug,verify:no-behavior-change')).toEqual([]);
  });

  it('returns an empty array when the JSON value is not an array', () => {
    expect(parseLabels('{"not":"an array"}')).toEqual([]);
    expect(parseLabels('"just a string"')).toEqual([]);
    expect(parseLabels('42')).toEqual([]);
  });

  it('drops empty-string entries after trimming', () => {
    expect(parseLabels('["", "  ", "bug"]')).toEqual(['bug']);
  });
});

describe('hasExemptLabel', () => {
  const EXEMPT = 'verify:no-behavior-change';

  it('matches an exact label', () => {
    expect(hasExemptLabel(['bug', EXEMPT, 'ci'], EXEMPT)).toBe(true);
  });

  it('does not match a near-miss superstring label', () => {
    expect(hasExemptLabel([`${EXEMPT}-not`], EXEMPT)).toBe(false);
  });

  it('does not match a prefix of the label', () => {
    expect(hasExemptLabel(['verify:no-behavior'], EXEMPT)).toBe(false);
  });

  it('does not match a case variant', () => {
    expect(hasExemptLabel(['Verify:No-Behavior-Change'], EXEMPT)).toBe(false);
  });

  it('does not match when the label list is empty', () => {
    expect(hasExemptLabel([], EXEMPT)).toBe(false);
  });
});

describe('isForkSafePromotionSkip', () => {
  const SAME_REPO = 'RevealUIStudio/revdev';
  const FORK_REPO = 'someone-else/revdev';

  it('fires for a same-repo test -> main PR', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: 'test',
        baseRef: 'main',
        headRepo: SAME_REPO,
        baseRepo: SAME_REPO,
      }),
    ).toBe(true);
  });

  it('does not fire when the head repo is a fork (branch named "test" but different repo)', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: 'test',
        baseRef: 'main',
        headRepo: FORK_REPO,
        baseRepo: SAME_REPO,
      }),
    ).toBe(false);
  });

  it('does not fire when the repo signal is entirely absent (e.g. a push event)', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: undefined,
        baseRef: undefined,
        headRepo: undefined,
        baseRepo: undefined,
      }),
    ).toBe(false);
  });

  it('does not fire when head/base ref match but the repo env vars were never wired', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: 'test',
        baseRef: 'main',
        headRepo: undefined,
        baseRepo: undefined,
      }),
    ).toBe(false);
  });

  it('does not fire for a feature branch into test', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: 'fix/x',
        baseRef: 'test',
        headRepo: SAME_REPO,
        baseRepo: SAME_REPO,
      }),
    ).toBe(false);
  });

  it('does not fire for test -> test', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: 'test',
        baseRef: 'test',
        headRepo: SAME_REPO,
        baseRepo: SAME_REPO,
      }),
    ).toBe(false);
  });

  it('does not fire when only the base ref matches (head ref is not "test")', () => {
    expect(
      isForkSafePromotionSkip({
        headRef: 'fix/renamed-to-main-by-mistake',
        baseRef: 'main',
        headRepo: SAME_REPO,
        baseRepo: SAME_REPO,
      }),
    ).toBe(false);
  });
});
