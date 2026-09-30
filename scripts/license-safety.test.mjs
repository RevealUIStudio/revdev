import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revokeJti, verifyLicenseJWT } from '../packages/daemon/src/license-crypto.ts';
import { issueLicense, revvaultSet, validateIssueOptions } from './issue-license.ts';
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
  process.env.REVDEV_LICENSE_PUBLIC_KEY = keys.publicKey;
  process.env.REVEALUI_ADMIN_API_KEY = 'synthetic-admin';
  process.env.REVEALUI_REVOKED_JTI_FILE = join(scratch, 'revoked.json');
});
afterEach(() => {
  delete process.env.REVDEV_LICENSE_PUBLIC_KEY;
  delete process.env.REVEALUI_ADMIN_API_KEY;
  delete process.env.REVEALUI_REVOKED_JTI_FILE;
  rmSync(scratch, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function legacyToken(extra = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      tier: 'enterprise',
      iat: Math.floor(Date.now() / 1000),
      iss: 'https://revealui.com',
      aud: 'revealui-license',
      ...extra,
    }),
  ).toString('base64url');
  const message = `${header}.${payload}`;
  return `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString('base64url')}`;
}

describe('license issuer and emergency rotation', () => {
  it('accepts only authenticated hosted registered issuance, with explicit perpetual grant', async () => {
    const token = legacyToken({
      customerId: 'synthetic',
      jti: '12345678-1234-4123-8123-123456789012',
    });
    const transport = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ licenseKey: token, tier: 'enterprise', customerId: 'synthetic' }),
        ),
      );
    vi.stubGlobal('fetch', transport);
    expect(
      await issueLicense({
        operationId: '12345678-1234-4123-8123-123456789012',
        tier: 'enterprise',
        customer: 'synthetic',
        perpetual: true,
      }),
    ).toBe(token);
    expect(transport).toHaveBeenCalledWith(
      'https://api.revealui.com/api/license/generate',
      expect.objectContaining({ redirect: 'error', body: expect.stringContaining('operationId') }),
    );
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
    const token = legacyToken({ customerId: 'synthetic', jti: 'synthetic-jti' });
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    payload.jti = 'forged-revocation-identity';
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
    expect(() => assertEmergencyRevocable(decodeLicense(forged), true)).not.toThrow();
    expect(() => assertSignedPriorLicense(forged, keys.publicKey)).toThrow('signature');
    expect(() => assertSignedPriorLicense(token, keys.publicKey)).not.toThrow();
  });

  it('rejects malformed issue and rotation options before a vault write', () => {
    expect(() => validateIssueOptions({ tier: 'invalid', customer: 'synthetic' })).toThrow('tier');
    expect(() => validateIssueOptions({ tier: 'pro', customer: '../other' })).toThrow('Customer');
    expect(() => validateIssueOptions({ tier: 'pro', days: -1 })).toThrow('days');
    expect(() => validateIssueOptions({ tier: 'pro', days: Number.NaN })).toThrow('days');
    expect(() => validateIssueOptions({ tier: 'pro', days: 30, perpetual: true })).toThrow(
      'either',
    );
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
    expect(() => validateIssueOptions({ tier: 'pro', customer: 'synthetic', store })).toThrow(
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

  it('refuses unsafe Vault force promotion', () => {
    expect(() => revvaultSet('revealui/dev/founder-license-key', 'synthetic')).toThrow(
      'force overwrite',
    );
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });
  it('fails closed on wrong customer, wrong signature, outage or missing operator identity', async () => {
    const opts = {
      operationId: '12345678-1234-4123-8123-123456789012',
      tier: 'enterprise',
      customer: 'synthetic',
      perpetual: true,
    };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic outage')));
    await expect(issueLicense(opts)).rejects.toThrow('unavailable');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              licenseKey: legacyToken({ customerId: 'other', jti: 'j' }),
              customerId: 'synthetic',
              tier: 'enterprise',
            }),
          ),
      ),
    );
    await expect(issueLicense(opts)).rejects.toThrow('invalid identity');
    const other = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    process.env.REVDEV_LICENSE_PUBLIC_KEY = other.publicKey;
    await expect(issueLicense(opts)).rejects.toThrow('trust migration');
    delete process.env.REVEALUI_ADMIN_API_KEY;
    await expect(issueLicense(opts)).rejects.toThrow('authentication');
  });
});
