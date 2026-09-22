import { describe, expect, it } from 'vitest';
import {
  biomeVersionMismatch,
  isRangeSpecifier,
  parseBiomeVersionOutput,
} from './check-biome-version.mjs';

describe('biome version pin', () => {
  it('parses the Version line Biome prints', () => {
    expect(parseBiomeVersionOutput('Version: 2.5.2\n')).toBe('2.5.2');
  });

  it('rejects a caret pin', () => {
    expect(isRangeSpecifier('^2.5.2')).toBe(true);
    expect(
      biomeVersionMismatch({
        declared: '^2.5.2',
        installed: '2.5.2',
        executed: '2.5.2',
      }),
    ).toContain('range');
  });

  it('rejects a stale installed binary', () => {
    expect(
      biomeVersionMismatch({
        declared: '2.5.2',
        installed: '2.5.0',
        executed: '2.5.0',
      }),
    ).toContain('2.5.0');
  });

  it('accepts one exact version in all three places', () => {
    expect(
      biomeVersionMismatch({
        declared: '2.5.2',
        installed: '2.5.2',
        executed: '2.5.2',
      }),
    ).toBeNull();
  });
});
