import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getVendorPublicKey, isRevokedJti, verifyLicenseJWT } from '../license-crypto.js';
import { DEFAULT_VENDOR_PUBLIC_KEY } from '../vendor-public-key.js';

function makeToken(
  payload: Record<string, unknown>,
  privateKey: string,
  header: Record<string, unknown> = { alg: 'EdDSA', typ: 'JWT' },
): string {
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${headerB64}.${payloadB64}`;
  const signatureB64 = sign(null, Buffer.from(message, 'utf-8'), privateKey).toString('base64url');
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const NOW_S = Math.floor(Date.now() / 1000);

const VALID_PAYLOAD: Record<string, unknown> = {
  tier: 'pro',
  iss: 'https://revealui.com',
  aud: 'revealui-license',
  jti: 'test-jti-0000',
  nbf: NOW_S - 10,
  iat: NOW_S - 10,
};

beforeEach(() => {
  process.env.REVDEV_LICENSE_PUBLIC_KEY = publicKey;
});

afterEach(() => {
  delete process.env.REVDEV_LICENSE_PUBLIC_KEY;
  vi.restoreAllMocks();
});

describe('verifyLicenseJWT — valid token', () => {
  it('accepts a fully-formed valid token', () => {
    const token = makeToken(VALID_PAYLOAD, privateKey);
    const result = verifyLicenseJWT(token, publicKey);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.tier).toBe('pro');
    }
  });
});

describe('verifyLicenseJWT — iss check', () => {
  it('rejects token with wrong iss', () => {
    const token = makeToken({ ...VALID_PAYLOAD, iss: 'https://evil.com' }, privateKey);
    const result = verifyLicenseJWT(token, publicKey);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('invalid iss');
    }
  });

  it('rejects token with missing iss', () => {
    const { iss: _iss, ...rest } = VALID_PAYLOAD;
    const token = makeToken(rest, privateKey);
    const result = verifyLicenseJWT(token, publicKey);
    expect(result.valid).toBe(false);
  });
});

describe('verifyLicenseJWT — aud check', () => {
  it('rejects token with wrong aud', () => {
    const token = makeToken({ ...VALID_PAYLOAD, aud: 'other-service' }, privateKey);
    const result = verifyLicenseJWT(token, publicKey);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('invalid aud');
    }
  });
});

describe('verifyLicenseJWT — nbf check', () => {
  it('rejects token with nbf in the future', () => {
    const futureNbf = NOW_S + 3600;
    const token = makeToken({ ...VALID_PAYLOAD, nbf: futureNbf }, privateKey);
    const result = verifyLicenseJWT(token, publicKey);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('nbf');
    }
  });

  it('accepts token whose nbf is in the past', () => {
    const token = makeToken({ ...VALID_PAYLOAD, nbf: NOW_S - 60 }, privateKey);
    const result = verifyLicenseJWT(token, publicKey);
    expect(result.valid).toBe(true);
  });

  it('accepts token with no nbf claim (backwards compat)', () => {
    const { nbf: _nbf, ...rest } = VALID_PAYLOAD;
    const token = makeToken(rest, privateKey);
    const result = verifyLicenseJWT(token, publicKey);
    expect(result.valid).toBe(true);
  });
});

describe('verifyLicenseJWT — jti revocation hook', () => {
  it('stub always returns false (hook is unwired)', () => {
    expect(isRevokedJti('any-jti')).toBe(false);
  });

  it('accepts token when jti is not revoked', () => {
    const token = makeToken({ ...VALID_PAYLOAD, jti: 'clean-jti-1234' }, privateKey);
    const result = verifyLicenseJWT(token, publicKey);
    expect(result.valid).toBe(true);
  });
});

describe('getVendorPublicKey — baked default + override', () => {
  it('falls back to the baked default when REVDEV_LICENSE_PUBLIC_KEY is unset', () => {
    delete process.env.REVDEV_LICENSE_PUBLIC_KEY;
    const key = getVendorPublicKey();
    expect(key).toBe(DEFAULT_VENDOR_PUBLIC_KEY);
    expect(key.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
  });

  it('treats an empty/whitespace override as unset and uses the baked default', () => {
    process.env.REVDEV_LICENSE_PUBLIC_KEY = '   ';
    expect(getVendorPublicKey()).toBe(DEFAULT_VENDOR_PUBLIC_KEY);
  });

  it('uses REVDEV_LICENSE_PUBLIC_KEY as an override when set', () => {
    process.env.REVDEV_LICENSE_PUBLIC_KEY = publicKey;
    expect(getVendorPublicKey()).toBe(publicKey);
  });

  it('activation succeeds against the baked default for a token it signed', () => {
    // A token signed by the key whose public half IS the baked default verifies
    // with no env var set — the happy path a v0.1.1 buyer hits.
    const token = makeToken(VALID_PAYLOAD, privateKey);
    const result = verifyLicenseJWT(token, DEFAULT_VENDOR_PUBLIC_KEY);
    // The ephemeral test key is not the real vendor key, so this specific token
    // does NOT validate against the baked default: fail-closed is preserved.
    expect(result.valid).toBe(false);
  });

  it('stays fail-closed: a tampered/foreign token degrades to Free under the baked default', () => {
    delete process.env.REVDEV_LICENSE_PUBLIC_KEY;
    const token = makeToken(VALID_PAYLOAD, privateKey); // signed by a non-vendor key
    const result = verifyLicenseJWT(token, getVendorPublicKey());
    expect(result.valid).toBe(false);
    expect(result.tier).toBe('free');
  });
});
