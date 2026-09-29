import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revokeJti, verifyLicenseJWT } from '../packages/daemon/src/license-crypto.ts';
import { generateKeypair, issueLicense, revvaultSet } from './issue-license.ts';
import {
  assertEmergencyRevocable,
  assertSignedPriorLicense,
  decodeLicense,
  validateRotateConfig,
} from './rotate-license.ts';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const keys = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
let scratch;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'revdev-license-audit-'));
  process.env.REVDEV_LICENSE_PRIVATE_KEY = keys.privateKey;
  process.env.REVEALUI_REVOKED_JTI_FILE = join(scratch, 'revoked.json');
});
afterEach(() => {
  delete process.env.REVDEV_LICENSE_PRIVATE_KEY;
  delete process.env.REVEALUI_REVOKED_JTI_FILE;
  rmSync(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function legacyToken() {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      tier: 'enterprise',
      iat: Math.floor(Date.now() / 1000),
      iss: 'https://revealui.com',
      aud: 'revealui-license',
    }),
  ).toString('base64url');
  const message = `${header}.${payload}`;
  return `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString('base64url')}`;
}

describe('license issuer and emergency rotation', () => {
  it('mints a perpetual key that the daemon can revoke by its unique jti', () => {
    const token = issueLicense({ tier: 'enterprise', customer: 'synthetic', perpetual: true });
    const prior = decodeLicense(token);
    expect(prior.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(prior.exp).toBeNull();
    expect(verifyLicenseJWT(token, keys.publicKey).valid).toBe(true);
    revokeJti(prior.jti);
    expect(verifyLicenseJWT(token, keys.publicKey)).toMatchObject({
      valid: false,
      code: 'revoked',
    });
  });

  it('refuses emergency replacement of a valid legacy key with no jti', () => {
    const token = legacyToken();
    expect(verifyLicenseJWT(token, keys.publicKey).valid).toBe(true);
    expect(() => assertSignedPriorLicense(token, keys.publicKey)).not.toThrow();
    expect(() => assertEmergencyRevocable(decodeLicense(token), true)).toThrow('old key valid');
    expect(() => assertEmergencyRevocable(decodeLicense(token), false)).not.toThrow();
  });

  it('refuses a parseable prior jti whose signature was changed', () => {
    const token = issueLicense({ tier: 'pro', customer: 'synthetic', perpetual: true });
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    payload.jti = 'forged-revocation-identity';
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
    expect(() => assertEmergencyRevocable(decodeLicense(forged), true)).not.toThrow();
    expect(() => assertSignedPriorLicense(forged, keys.publicKey)).toThrow('signature');
    expect(() => assertSignedPriorLicense(token, keys.publicKey)).not.toThrow();
  });

  it('rejects malformed issue and rotation options before a vault write', () => {
    expect(() => issueLicense({ tier: 'invalid', customer: 'synthetic' })).toThrow('tier');
    expect(() => issueLicense({ tier: 'pro', customer: '../other' })).toThrow('Customer');
    expect(() => issueLicense({ tier: 'pro', days: -1 })).toThrow('days');
    expect(() => issueLicense({ tier: 'pro', days: Number.NaN })).toThrow('days');
    expect(() => issueLicense({ tier: 'pro', days: 30, perpetual: true })).toThrow('either');
    const cfg = {
      vaultPath: 'revealui/dev/founder-license-key',
      tier: 'enterprise',
      days: 90,
      thresholdDays: 14,
    };
    expect(() => validateRotateConfig({ ...cfg, days: -1 })).toThrow('days');
    expect(() => validateRotateConfig({ ...cfg, thresholdDays: -1 })).toThrow('Threshold');
    expect(() => validateRotateConfig({ ...cfg, tier: 'invalid' })).toThrow('tier');
  });

  it.each([
    'revdev/license-signing-private-key',
    'revdev/license-signing-public-key',
    'forge/customers/../license-key',
    '--force',
  ])('rejects unsupported vault destination %s before key access or storage', (store) => {
    expect(() => issueLicense({ tier: 'pro', customer: 'synthetic', store })).toThrow(
      'supported license-key path',
    );
    expect(() => revvaultSet(store, 'synthetic-jwt')).toThrow('supported license-key path');
    expect(() =>
      validateRotateConfig({
        vaultPath: store,
        tier: 'pro',
        days: 90,
        thresholdDays: 14,
      }),
    ).toThrow('supported license-key path');
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it('will not overwrite either existing signing key during first-time setup', () => {
    vi.mocked(execFileSync).mockReturnValue('existing');
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('blocked exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => generateKeypair()).toThrow('blocked exit');
    expect(vi.mocked(execFileSync).mock.calls.every(([, args]) => args[0] === 'get')).toBe(true);
  });

  it('creates a new signing pair without force when both paths are absent', () => {
    const writes = [];
    vi.mocked(execFileSync).mockImplementation((_, args) => {
      if (args[0] === 'get') throw new Error('not found');
      writes.push(args);
      return '';
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    generateKeypair();
    expect(writes).toEqual([
      ['set', 'revdev/license-signing-private-key'],
      ['set', 'revdev/license-signing-public-key'],
    ]);
  });
});
