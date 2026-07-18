import { describe, expect, it } from 'vitest';
import { BASE58_ALPHABET, base58Decode, base58Encode } from '../base58.js';

describe('BASE58_ALPHABET', () => {
  it('has exactly 58 characters, all distinct', () => {
    const chars = BASE58_ALPHABET.split('');
    expect(chars.length).toBe(58);
    expect(new Set(chars).size).toBe(58);
  });

  it('excludes the visually ambiguous characters (0, O, I, l)', () => {
    for (const ambiguous of ['0', 'O', 'I', 'l']) {
      expect(BASE58_ALPHABET.includes(ambiguous)).toBe(false);
    }
  });
});

describe('base58Encode', () => {
  it('encodes an empty byte array as an empty string', () => {
    expect(base58Encode(new Uint8Array(0))).toBe('');
  });

  it('encodes a single zero byte as a single leading-zero character', () => {
    expect(base58Encode(new Uint8Array([0]))).toBe('1');
  });

  it('matches the well-known "Hello World!" base58 vector', () => {
    const bytes = new TextEncoder().encode('Hello World!');
    expect(base58Encode(bytes)).toBe('2NEpo7TZRRrLZSi2U');
  });

  it('preserves leading zero bytes as leading "1" characters', () => {
    const encoded = base58Encode(new Uint8Array([0, 0, 1]));
    expect(encoded.startsWith('11')).toBe(true);
  });
});

describe('base58Decode', () => {
  it('decodes an empty string to an empty byte array', () => {
    expect(base58Decode('').length).toBe(0);
  });

  it('rejects a character outside the alphabet', () => {
    expect(() => base58Decode('0')).toThrow();
    expect(() => base58Decode('abcO')).toThrow();
  });

  it('reports the offending character and position', () => {
    expect(() => base58Decode('ab0cd')).toThrow("invalid character '0' at position 2");
  });
});

describe('base58 round trip', () => {
  const vectors: Uint8Array[] = [
    new Uint8Array(0),
    new Uint8Array([0]),
    new Uint8Array([0, 0, 0]),
    new Uint8Array([1, 2, 3, 254, 255]),
    new Uint8Array([0, 0, 1, 2, 3, 254, 255]),
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)),
  ];

  for (const bytes of vectors) {
    it(`recovers the original bytes for length ${bytes.length}`, () => {
      const decoded = base58Decode(base58Encode(bytes));
      expect(Array.from(decoded)).toEqual(Array.from(bytes));
    });
  }
});
