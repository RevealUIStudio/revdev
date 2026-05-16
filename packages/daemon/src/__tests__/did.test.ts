import { base58Decode, base58Encode } from '@revdev/protocol/base58';
import {
  DID_PREFIX,
  formatDid,
  isValidAgentId,
  isValidAgentIdChar,
  isValidFingerprint,
  parseDid,
} from '@revdev/protocol/did';
import { describe, expect, it } from 'vitest';

describe('formatDid', () => {
  it('formats a valid DID', () => {
    expect(formatDid('agt-001', 'abc123')).toBe('did:revfleet:agt-001:abc123');
  });

  it('uses DID_PREFIX', () => {
    const did = formatDid('agent', 'fp1');
    expect(did.startsWith(DID_PREFIX)).toBe(true);
  });

  it('throws TypeError for invalid agentId', () => {
    expect(() => formatDid('', 'abc123')).toThrow(TypeError);
    expect(() => formatDid('has space', 'abc123')).toThrow(TypeError);
  });

  it('throws TypeError for invalid fingerprint', () => {
    expect(() => formatDid('agt', '0OIl')).toThrow(TypeError);
  });
});

describe('parseDid', () => {
  it('parses a valid DID', () => {
    const result = parseDid('did:revfleet:agt-001:abc123');
    expect(result).toEqual({ agentId: 'agt-001', fingerprint: 'abc123' });
  });

  it('returns null for wrong prefix', () => {
    expect(parseDid('did:other:x:y')).toBeNull();
  });

  it('returns null when fingerprint is missing', () => {
    expect(parseDid('did:revfleet:agt-001')).toBeNull();
  });

  it('returns null when agentId is empty', () => {
    expect(parseDid('did:revfleet::abc')).toBeNull();
  });

  it('returns null when fingerprint is empty', () => {
    expect(parseDid('did:revfleet:agent:')).toBeNull();
  });

  it('returns null for extra colons in fingerprint', () => {
    expect(parseDid('did:revfleet:agent:fp:extra')).toBeNull();
  });
});

describe('isValidAgentId', () => {
  it('returns true for a valid agent id', () => {
    expect(isValidAgentId('agent_01-test')).toBe(true);
    expect(isValidAgentId('a')).toBe(true);
    expect(isValidAgentId('ABC-123_xyz')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isValidAgentId('')).toBe(false);
  });

  it('returns false for a string with a space', () => {
    expect(isValidAgentId('has space')).toBe(false);
  });

  it('returns false for a string with an emoji', () => {
    expect(isValidAgentId('emoji\u{1F600}')).toBe(false);
  });

  it('returns false for a string longer than 128 chars', () => {
    expect(isValidAgentId('a'.repeat(129))).toBe(false);
  });

  it('returns true for exactly 128 chars', () => {
    expect(isValidAgentId('a'.repeat(128))).toBe(true);
  });
});

describe('isValidAgentIdChar', () => {
  const validChars = ['0', '9', 'a', 'z', 'A', 'Z', '_', '-'];
  for (const c of validChars) {
    it(`returns true for '${c}'`, () => {
      expect(isValidAgentIdChar(c)).toBe(true);
    });
  }

  const invalidChars = [' ', '.', '/', ':'];
  for (const c of invalidChars) {
    it(`returns false for '${c}'`, () => {
      expect(isValidAgentIdChar(c)).toBe(false);
    });
  }
});

describe('isValidFingerprint', () => {
  it('returns true for valid base58btc chars', () => {
    expect(isValidFingerprint('123456789ABC')).toBe(true);
  });

  it('returns false for chars not in base58 alphabet (0, O, I, l)', () => {
    expect(isValidFingerprint('0')).toBe(false);
    expect(isValidFingerprint('O')).toBe(false);
    expect(isValidFingerprint('I')).toBe(false);
    expect(isValidFingerprint('l')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isValidFingerprint('')).toBe(false);
  });
});

describe('base58Encode + base58Decode', () => {
  it('roundtrip on bytes including leading zeros', () => {
    const original = Uint8Array.of(0, 0, 0, 1, 2, 3);
    const encoded = base58Encode(original);
    const decoded = base58Decode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('encodes empty Uint8Array to empty string', () => {
    expect(base58Encode(new Uint8Array(0))).toBe('');
  });

  it('decodes empty string to empty Uint8Array', () => {
    expect(base58Decode('').length).toBe(0);
  });

  it('throws on invalid base58 character', () => {
    expect(() => base58Decode('0abc')).toThrow('base58:');
  });

  it('leading 1s in encoded string map to leading zero bytes', () => {
    const bytes = Uint8Array.of(0, 0, 5);
    const encoded = base58Encode(bytes);
    expect(encoded.startsWith('11')).toBe(true);
    const decoded = base58Decode(encoded);
    expect(Array.from(decoded)).toEqual([0, 0, 5]);
  });
});
