import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DAEMON_DEFAULTS } from '../config.js';
import { checkLicense, isExemptMethod, LICENSE_TIERS } from '../license.js';
import { verifyLicenseJWT } from '../license-crypto.js';
import { SCHEMA_SQL } from '../storage/schema.js';
import {
  clearTestLicenseEnv,
  generateTestLicense,
  setTestLicenseEnv,
} from './test-license-helper.js';

describe('license', () => {
  it('returns free tier when no key is set', () => {
    const original = process.env.REVEALUI_LICENSE_KEY;
    clearTestLicenseEnv();

    const result = checkLicense();
    expect(result.tier).toBe('free');
    expect(result.valid).toBe(false);

    if (original) process.env.REVEALUI_LICENSE_KEY = original;
  });

  it('validates a pro JWT license key', () => {
    setTestLicenseEnv(generateTestLicense('pro'));
    const result = checkLicense();
    expect(result.tier).toBe('pro');
    expect(result.valid).toBe(true);
    clearTestLicenseEnv();
  });

  it('validates a max JWT license key', () => {
    setTestLicenseEnv(generateTestLicense('max'));
    const result = checkLicense();
    expect(result.tier).toBe('max');
    expect(result.valid).toBe(true);
    clearTestLicenseEnv();
  });

  it('validates an enterprise JWT license key', () => {
    setTestLicenseEnv(generateTestLicense('enterprise'));
    const result = checkLicense();
    expect(result.tier).toBe('enterprise');
    expect(result.valid).toBe(true);
    clearTestLicenseEnv();
  });

  it('validates a non-perpetual JWT license key (with exp)', () => {
    setTestLicenseEnv(generateTestLicense('pro', false, { daysUntilExpiry: 30 }));
    const result = checkLicense();
    expect(result.tier).toBe('pro');
    expect(result.valid).toBe(true);
    clearTestLicenseEnv();
  });

  it('rejects a dotted-v2 format license (legacy)', () => {
    process.env.REVEALUI_LICENSE_KEY = 'RVUI.v2.pro.0.somesig';
    const result = checkLicense();
    expect(result.tier).toBe('free');
    expect(result.valid).toBe(false);
    clearTestLicenseEnv();
  });

  it('rejects v1 license keys', () => {
    process.env.REVEALUI_LICENSE_KEY = 'RVUI-pro-abcdef0123456789abcdef0123456789';
    const result = checkLicense();
    expect(result.tier).toBe('free');
    expect(result.valid).toBe(false);
    clearTestLicenseEnv();
  });

  it('rejects invalid license key formats', () => {
    process.env.REVEALUI_LICENSE_KEY = 'invalid-key';
    const result = checkLicense();
    expect(result.tier).toBe('free');
    expect(result.valid).toBe(false);
    clearTestLicenseEnv();
  });

  it('exports all known license tiers', () => {
    expect(LICENSE_TIERS).toEqual(['free', 'pro', 'max', 'enterprise']);
  });

  it('marks session methods as exempt', () => {
    expect(isExemptMethod('ping')).toBe(true);
    expect(isExemptMethod('session.register')).toBe(true);
    expect(isExemptMethod('agent.spawn')).toBe(false);
    expect(isExemptMethod('merge.request')).toBe(false);
  });
});

describe('verifyLicenseJWT — negative cases', () => {
  it('rejects an RS256-signed JWT (algorithm mismatch)', () => {
    const { privateKey: rsaPriv, publicKey: edPub } = (() => {
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const { publicKey } = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      return { privateKey, publicKey };
    })();

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ tier: 'pro' })).toString('base64url');
    const sig = sign('sha256', Buffer.from(`${header}.${payload}`), rsaPriv).toString('base64url');
    const rs256Jwt = `${header}.${payload}.${sig}`;

    const result = verifyLicenseJWT(rs256Jwt, edPub as string);
    expect(result.valid).toBe(false);
    expect('reason' in result && result.reason).toBe('unsupported algorithm');
  });

  it('rejects a JWT signed with the wrong Ed25519 key', () => {
    const kit = generateTestLicense('pro');
    const { publicKey: wrongPub } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const result = verifyLicenseJWT(kit.licenseKey, wrongPub as string);
    expect(result.valid).toBe(false);
    expect('reason' in result && result.reason).toBe('invalid signature');
  });

  it('rejects a JWT with non-JSON payload', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const payloadB64 = Buffer.from('not-json-at-all!!!').toString('base64url');
    const message = `${header}.${payloadB64}`;
    const sig = sign(null, Buffer.from(message), privateKey).toString('base64url');

    const result = verifyLicenseJWT(`${message}.${sig}`, publicKey as string);
    expect(result.valid).toBe(false);
    expect('reason' in result && result.reason).toBe('invalid format');
  });

  it('rejects a JWT with an unrecognized tier', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const payloadB64 = Buffer.from(
      JSON.stringify({ tier: 'gold', iat: Math.floor(Date.now() / 1000) }),
    ).toString('base64url');
    const message = `${header}.${payloadB64}`;
    const sig = sign(null, Buffer.from(message), privateKey).toString('base64url');

    const result = verifyLicenseJWT(`${message}.${sig}`, publicKey as string);
    expect(result.valid).toBe(false);
    expect('reason' in result && result.reason).toContain('invalid tier');
  });

  it('rejects an expired JWT', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const payloadB64 = Buffer.from(
      JSON.stringify({ tier: 'pro', iat: now - 7200, exp: now - 3600 }),
    ).toString('base64url');
    const message = `${header}.${payloadB64}`;
    const sig = sign(null, Buffer.from(message), privateKey).toString('base64url');

    const result = verifyLicenseJWT(`${message}.${sig}`, publicKey as string);
    expect(result.valid).toBe(false);
    expect('reason' in result && result.reason).toBe('license expired');
  });

  it('accepts a perpetual JWT (no exp claim)', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    // No exp claim
    const payloadB64 = Buffer.from(
      JSON.stringify({ tier: 'enterprise', iat: now }),
    ).toString('base64url');
    const message = `${header}.${payloadB64}`;
    const sig = sign(null, Buffer.from(message), privateKey).toString('base64url');

    const result = verifyLicenseJWT(`${message}.${sig}`, publicKey as string);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.tier).toBe('enterprise');
      expect(result.expiresAt).toBe(0);
    }
  });

  it('rejects a JWT with only two parts (malformed)', () => {
    const { publicKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const result = verifyLicenseJWT('header.payload', publicKey as string);
    expect(result.valid).toBe(false);
    expect('reason' in result && result.reason).toBe('invalid format');
  });
});

describe('schema', () => {
  it('exports SCHEMA_SQL as a non-empty string', () => {
    expect(typeof SCHEMA_SQL).toBe('string');
    expect(SCHEMA_SQL.length).toBeGreaterThan(100);
  });

  it('contains all expected table definitions', () => {
    const tables = [
      'agent_sessions',
      'agent_messages',
      'file_reservations',
      'tasks',
      'events',
      'worktrees',
      'agent_memory',
      'merge_requests',
    ];
    for (const table of tables) {
      expect(SCHEMA_SQL).toContain(table);
    }
  });
});

describe('config', () => {
  it('exports default daemon configuration', () => {
    expect(DAEMON_DEFAULTS.socketPath).toContain('harness.sock');
    expect(DAEMON_DEFAULTS.httpPort).toBe(0);
    expect(DAEMON_DEFAULTS.httpHost).toBe('127.0.0.1');
    expect(DAEMON_DEFAULTS.maxMemoryMb).toBe(512);
  });
});
