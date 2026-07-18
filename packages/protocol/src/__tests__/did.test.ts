import { describe, expect, it } from 'vitest';
import {
  DID_PREFIX,
  formatDid,
  isValidAgentId,
  isValidAgentIdChar,
  isValidFingerprint,
  parseDid,
} from '../did.js';

describe('isValidAgentIdChar', () => {
  it('accepts alphanumerics, underscore, and hyphen', () => {
    for (const c of ['a', 'Z', '5', '_', '-']) {
      expect(isValidAgentIdChar(c)).toBe(true);
    }
  });

  it('rejects everything else, including empty and multi-char input', () => {
    for (const c of [' ', ':', '.', '', 'ab']) {
      expect(isValidAgentIdChar(c)).toBe(false);
    }
  });
});

describe('isValidAgentId', () => {
  it('rejects the empty string', () => {
    expect(isValidAgentId('')).toBe(false);
  });

  it('accepts exactly 128 characters', () => {
    expect(isValidAgentId('a'.repeat(128))).toBe(true);
  });

  it('rejects 129 characters', () => {
    expect(isValidAgentId('a'.repeat(129))).toBe(false);
  });

  it('rejects a string containing an invalid character', () => {
    expect(isValidAgentId('agent id')).toBe(false);
    expect(isValidAgentId('agent:id')).toBe(false);
  });
});

describe('isValidFingerprint', () => {
  it('rejects the empty string', () => {
    expect(isValidFingerprint('')).toBe(false);
  });

  it('accepts exactly 128 characters drawn from the base58 alphabet', () => {
    expect(isValidFingerprint('1'.repeat(128))).toBe(true);
  });

  it('rejects 129 characters', () => {
    expect(isValidFingerprint('1'.repeat(129))).toBe(false);
  });

  it('rejects characters outside the base58 alphabet', () => {
    expect(isValidFingerprint('abc0def')).toBe(false);
    expect(isValidFingerprint('abcOdef')).toBe(false);
  });
});

describe('formatDid', () => {
  it('formats a valid agentId/fingerprint pair under DID_PREFIX', () => {
    expect(formatDid('agt-001', 'abc123')).toBe(`${DID_PREFIX}agt-001:abc123`);
  });

  it('throws TypeError for an invalid agentId', () => {
    expect(() => formatDid('', 'abc123')).toThrow(TypeError);
    expect(() => formatDid('has space', 'abc123')).toThrow(TypeError);
  });

  it('throws TypeError for an invalid fingerprint', () => {
    expect(() => formatDid('agt', '0OIl')).toThrow(TypeError);
  });
});

describe('parseDid', () => {
  it('round-trips through formatDid', () => {
    const did = formatDid('agt-001', 'abc123');
    expect(parseDid(did)).toEqual({ agentId: 'agt-001', fingerprint: 'abc123' });
  });

  it('returns null for a did without the expected prefix', () => {
    expect(parseDid('did:other:agt:fp')).toBeNull();
  });

  it('returns null when there is no fingerprint separator', () => {
    expect(parseDid(`${DID_PREFIX}agt-001`)).toBeNull();
  });

  it('returns null when the agentId or fingerprint segment is empty', () => {
    expect(parseDid(`${DID_PREFIX}:fp`)).toBeNull();
    expect(parseDid(`${DID_PREFIX}agt:`)).toBeNull();
  });

  it('returns null when the fingerprint segment itself contains a colon', () => {
    expect(parseDid(`${DID_PREFIX}agt:fp:extra`)).toBeNull();
  });
});
