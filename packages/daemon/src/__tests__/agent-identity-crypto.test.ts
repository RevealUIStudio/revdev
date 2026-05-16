import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalizeJSON,
  computeFingerprint,
  generateAgentKeypair,
  hashParams,
  parseEnvelope,
  serializeEnvelope,
  signEnvelope,
  verifyEnvelope,
} from '../agent-identity-crypto.js';
import type { SignaturePayload } from '@revdev/protocol/signature';

function makePayload(overrides: Partial<SignaturePayload> = {}): SignaturePayload {
  return {
    did: 'did:revfleet:test-agent:abc123',
    kid: 'did:revfleet:test-agent:abc123',
    nonce: 'aabbccddeeff00112233445566778899',
    ts: Date.now(),
    method: 'ping',
    paramsHash: 'somehash',
    ...overrides,
  };
}

describe('generateAgentKeypair', () => {
  it('returns a 32-byte raw public key', () => {
    const kp = generateAgentKeypair();
    expect(kp.publicKeyRaw.length).toBe(32);
  });

  it('returns valid PEM strings', () => {
    const kp = generateAgentKeypair();
    expect(kp.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
    expect(kp.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
  });
});

describe('computeFingerprint', () => {
  it('produces a non-empty base58 string', () => {
    const kp = generateAgentKeypair();
    const fp = computeFingerprint(kp.publicKeyRaw);
    expect(fp.length).toBeGreaterThan(0);
    expect(typeof fp).toBe('string');
  });

  it('is deterministic for the same key', () => {
    const kp = generateAgentKeypair();
    expect(computeFingerprint(kp.publicKeyRaw)).toBe(computeFingerprint(kp.publicKeyRaw));
  });
});

describe('signEnvelope + verifyEnvelope', () => {
  it('roundtrip returns true', () => {
    const kp = generateAgentKeypair();
    const payload = makePayload();
    const envelope = signEnvelope(payload, kp.privateKeyPem);
    expect(verifyEnvelope(envelope, kp.publicKeyPem)).toBe(true);
  });

  it('tamper detection: flip one byte in serialized envelope signature, parse, verify returns false', () => {
    const kp = generateAgentKeypair();
    const payload = makePayload();
    const envelope = signEnvelope(payload, kp.privateKeyPem);
    const serialized = serializeEnvelope(envelope);

    const parts = serialized.split('.');
    const sigBytes = Buffer.from(parts[2] as string, 'base64url');
    sigBytes[0] = (sigBytes[0] as number) ^ 0xff;
    parts[2] = sigBytes.toString('base64url');
    const tampered = parts.join('.');

    const parsed = parseEnvelope(tampered);
    expect(parsed).not.toBeNull();
    if (parsed !== null) {
      expect(verifyEnvelope(parsed, kp.publicKeyPem)).toBe(false);
    }
  });

  it('rejects wrong key', () => {
    const kp = generateAgentKeypair();
    const otherKp = generateAgentKeypair();
    const payload = makePayload();
    const envelope = signEnvelope(payload, kp.privateKeyPem);
    expect(verifyEnvelope(envelope, otherKp.publicKeyPem)).toBe(false);
  });
});

describe('serializeEnvelope + parseEnvelope roundtrip', () => {
  it('parses back to the same envelope', () => {
    const kp = generateAgentKeypair();
    const payload = makePayload();
    const envelope = signEnvelope(payload, kp.privateKeyPem);
    const serialized = serializeEnvelope(envelope);
    const parsed = parseEnvelope(serialized);

    expect(parsed).not.toBeNull();
    if (parsed !== null) {
      expect(parsed.header.alg).toBe('EdDSA');
      expect(parsed.header.typ).toBe('jws');
      expect(parsed.payload.method).toBe(payload.method);
      expect(parsed.payload.nonce).toBe(payload.nonce);
      expect(parsed.signature).toBe(envelope.signature);
    }
  });
});

describe('parseEnvelope null-on-malformed', () => {
  it('returns null on wrong part count (2 parts)', () => {
    expect(parseEnvelope('a.b')).toBeNull();
  });

  it('returns null on wrong part count (4 parts)', () => {
    expect(parseEnvelope('a.b.c.d')).toBeNull();
  });

  it('returns null on non-base64 header', () => {
    expect(parseEnvelope('!!!.b.c')).toBeNull();
  });

  it('returns null on valid base64 but non-JSON header', () => {
    const notJson = Buffer.from('not-json').toString('base64url');
    expect(parseEnvelope(`${notJson}.${notJson}.sig`)).toBeNull();
  });

  it('returns null on schema mismatch (wrong alg)', () => {
    const kp = generateAgentKeypair();
    const payload = makePayload();
    const badHeader = { alg: 'RS256', typ: 'jws' };
    const headerB64 = Buffer.from(JSON.stringify(badHeader)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = Buffer.from('fakesig').toString('base64url');
    expect(parseEnvelope(`${headerB64}.${payloadB64}.${sig}`)).toBeNull();
  });
});

describe('canonicalizeJSON', () => {
  it('produces stable output for equivalent objects with different key order', () => {
    const a = canonicalizeJSON({ b: 1, a: 2 });
    const b = canonicalizeJSON({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it('handles nested objects', () => {
    const result = canonicalizeJSON({ z: { y: 1, x: 2 }, a: true });
    expect(result).toBe('{"a":true,"z":{"x":2,"y":1}}');
  });

  it('handles arrays', () => {
    const result = canonicalizeJSON([3, 1, 2]);
    expect(result).toBe('[3,1,2]');
  });

  it('handles null', () => {
    expect(canonicalizeJSON(null)).toBe('null');
  });

  it('handles numbers', () => {
    expect(canonicalizeJSON(42)).toBe('42');
    expect(canonicalizeJSON(3.14)).toBe('3.14');
  });

  it('handles strings', () => {
    expect(canonicalizeJSON('hello')).toBe('"hello"');
  });

  it('handles nested arrays in objects', () => {
    const result = canonicalizeJSON({ b: [2, 1], a: [3, 4] });
    expect(result).toBe('{"a":[3,4],"b":[2,1]}');
  });
});

describe('hashParams', () => {
  it('is deterministic', () => {
    const h1 = hashParams('ping', { key: 'value', num: 42 });
    const h2 = hashParams('ping', { num: 42, key: 'value' });
    expect(h1).toBe(h2);
  });

  it('differs for different methods', () => {
    const h1 = hashParams('ping', {});
    const h2 = hashParams('pong', {});
    expect(h1).not.toBe(h2);
  });

  it('handles null/undefined params', () => {
    expect(hashParams('ping', null)).toBe(hashParams('ping', undefined));
  });
});

describe('base64UrlEncode + base64UrlDecode', () => {
  it('roundtrips arbitrary bytes', () => {
    const original = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x80]);
    const encoded = base64UrlEncode(original);
    const decoded = base64UrlDecode(encoded);
    expect(Buffer.from(decoded).equals(original)).toBe(true);
  });

  it('roundtrips a Uint8Array', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = base64UrlEncode(original);
    const decoded = base64UrlDecode(encoded);
    expect(Array.from(decoded)).toEqual([1, 2, 3, 4, 5]);
  });
});
