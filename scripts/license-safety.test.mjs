import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revokeJti, verifyLicenseJWT } from '../packages/daemon/src/license-crypto.ts';
import {
  issueLicense,
  promoteLicense,
  readCurrentLicense,
  revvaultSet,
  validateIssueOptions,
} from './issue-license.ts';
import {
  assertEmergencyRevocable,
  assertSignedPriorLicense,
  decodeLicense,
  rotateLicense,
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

  it('validates the real rotation operation UUID before accessing Vault', () => {
    const cfg = {
      vaultPath: 'revealui/dev/founder-license-key',
      operationId: '12345678-1234-4123-8123-123456789012',
      expectedMode: 'live',
      tier: 'enterprise',
      days: 90,
      perpetual: false,
      thresholdDays: 14,
      emergency: false,
    };
    expect(() => validateRotateConfig(cfg)).not.toThrow();
    expect(() => validateRotateConfig({ ...cfg, operationId: undefined })).toThrow(
      'operation UUID',
    );
    expect(() => validateRotateConfig({ ...cfg, operationId: 'invalid' })).toThrow(
      'operation UUID',
    );
    expect(execFileSync).not.toHaveBeenCalled();
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

  it('refuses unbound Vault promotion', () => {
    expect(() => revvaultSet('revealui/dev/founder-license-key', 'synthetic')).toThrow(
      'stable operation UUID',
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

describe('maintained Vault conditional consumer boundary', () => {
  const path = 'revealui/dev/founder-license-key';
  const operationId = 'abcdef12-abcd-4123-8123-abcdef123456';
  function receipt(extra = {}) {
    return JSON.stringify({
      operation_id: operationId,
      path,
      status: 'committed',
      current_matches: true,
      ...extra,
    });
  }

  it('reads exact stored bytes and keeps canonical-token transport separate', () => {
    const raw = '  signed.synthetic.token\n';
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({ path, value: raw, bytes: Buffer.byteLength(raw) }),
    );
    expect(readCurrentLicense(path)).toEqual({
      raw,
      token: raw.trim(),
      sha256: createHash('sha256').update(raw).digest('hex'),
    });
    expect(execFileSync).toHaveBeenCalledWith(
      'revvault',
      ['--json', 'get', path],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it.each([
    'not JSON',
    JSON.stringify({ path: 'other', value: 'synthetic', bytes: 9 }),
    JSON.stringify({ path, value: 'synthetic', bytes: 1 }),
    JSON.stringify({ path, value: '\ud800', bytes: 3 }),
    JSON.stringify({ path, value: 'synthetic', bytes: 9, status: 'extra' }),
  ])('rejects malformed or mismatched JSON reads without assuming absence', (output) => {
    vi.mocked(execFileSync).mockReturnValue(output);
    expect(() => readCurrentLicense(path)).toThrow(/unavailable|invalid byte identity/);
  });

  it('sanitizes Vault read failures without exposing child buffers', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('synthetic-sensitive-child-output');
    });
    let message;
    try {
      readCurrentLicense(path);
    } catch (error) {
      message = error.message;
    }
    expect(message).toBe('Current Vault license is unavailable; refusing promotion.');
  });

  it.each([
    { kind: 'absent' },
    { kind: 'sha256', sha256: 'a'.repeat(64) },
  ])('writes desired bytes only on stdin under original immutable expectation %j', (expected) => {
    vi.mocked(execFileSync).mockReturnValue(receipt());
    revvaultSet(path, 'synthetic-sensitive-token\n', operationId.toUpperCase(), expected);
    const flags =
      expected.kind === 'absent'
        ? ['--expected-absent']
        : ['--expected-current-sha256', expected.sha256];
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      'revvault',
      ['set', path, '--operation-id', operationId, ...flags],
      { input: 'synthetic-sensitive-token\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  });

  it.each([
    { kind: 'absent', extra: true },
    { kind: 'sha256', sha256: 'bad' },
    { kind: 'sha256', sha256: 'A'.repeat(64) },
    { kind: 'other' },
  ])('rejects invalid expectations before any write %j', (expected) => {
    expect(() => revvaultSet(path, 'synthetic', operationId, expected)).toThrow(
      'immutable Vault expectation',
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each([
    { operation_id: 'different' },
    { path: 'different' },
    { status: 'stored' },
    { current_matches: 1 },
    { extra: 'unrecognized' },
  ])('rejects malformed CAS receipt identity %j', (extra) => {
    vi.mocked(execFileSync).mockReturnValue(receipt(extra));
    expect(() => revvaultSet(path, 'synthetic', operationId, { kind: 'absent' })).toThrow(
      'invalid receipt',
    );
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('never reports a historical superseded commit as installed or restores it', () => {
    vi.mocked(execFileSync).mockReturnValue(receipt({ current_matches: false }));
    expect(() => revvaultSet(path, 'synthetic', operationId, { kind: 'absent' })).toThrow(
      'superseded',
    );
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('sanitizes conflicting or unsupported conditional CLI failures without force fallback', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('synthetic-sensitive-child-output');
    });
    expect(() => revvaultSet(path, 'synthetic', operationId, { kind: 'absent' })).toThrow(
      'Vault conditional promotion unavailable or conflicting; hosted containment remains committed.',
    );
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('hosted durable promotion recovery', () => {
  const operationId = 'abcdef12-abcd-4123-8123-abcdef123456';
  const path = 'forge/customers/synthetic/license-key';
  const opts = {
    operationId,
    tier: 'enterprise',
    customer: 'synthetic',
    perpetual: true,
    expectedMode: 'live',
  };
  const identity = { kind: 'rotation', path };
  const prior = 'old-registered-token';
  const expected = {
    kind: 'sha256',
    sha256: createHash('sha256').update(`  ${prior}\n`).digest('hex'),
  };
  const prepare = () => ({ expected, expectedCurrentLicenseKey: prior });
  function receipt(kind = 'rotation') {
    return {
      licenseKey: legacyToken({ customerId: 'synthetic', jti: operationId, perpetual: true }),
      tier: 'enterprise',
      customerId: 'synthetic',
      operation: {
        version: 1,
        operationId,
        customerId: 'synthetic',
        mode: 'live',
        grant: {
          tier: 'enterprise',
          domains: null,
          maxSites: null,
          maxUsers: null,
          perpetual: true,
          expiresInSeconds: null,
        },
        effectiveGrant: {
          tier: 'enterprise',
          domains: null,
          maxSites: null,
          maxUsers: null,
          perpetual: true,
          expiresInSeconds: null,
        },
        action: kind,
        expectedCurrentLicenseKeySha256:
          kind === 'rotation' ? createHash('sha256').update(prior).digest('hex') : null,
        promotion: {
          kind,
          path,
          expected: kind === 'rotation' ? { ...expected } : { kind: 'absent' },
        },
      },
    };
  }
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const miss = () =>
    new Response(JSON.stringify({ error: 'operation_not_found' }), { status: 404 });
  function vaultReceipt() {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        operation_id: operationId,
        path,
        status: 'committed',
        current_matches: true,
      }),
    );
  }
  it('recovers before observing a changed or fenced Vault prior', async () => {
    vaultReceipt();
    const read = vi.fn(() => {
      throw new Error('must not read');
    });
    const fetch = vi.fn().mockResolvedValue(response(receipt()));
    vi.stubGlobal('fetch', fetch);
    await expect(promoteLicense(opts, identity, read)).resolves.toMatchObject({
      status: 'promoted',
    });
    expect(read).not.toHaveBeenCalled();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty('expiresInDays');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      recoverOnly: true,
      action: 'rotation',
      expectedMode: 'live',
      promotion: identity,
    });
    expect(execFileSync.mock.calls[0][1]).toContain(expected.sha256);
  });
  it('uses initial absent expectation only after authenticated proven miss', async () => {
    vaultReceipt();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(miss())
      .mockResolvedValueOnce(response(receipt('initial'), 201));
    vi.stubGlobal('fetch', fetch);
    await promoteLicense(opts, { kind: 'initial', path }, () => ({ expected: { kind: 'absent' } }));
    expect(JSON.parse(fetch.mock.calls[1][1].body).promotion.expected).toEqual({ kind: 'absent' });
    expect(execFileSync.mock.calls[0][1]).toContain('--expected-absent');
  });
  it('recovers committed timeout without rebuilding prior or minting twice', async () => {
    vaultReceipt();
    const read = vi.fn(prepare);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(miss())
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(response(receipt()));
    vi.stubGlobal('fetch', fetch);
    await promoteLicense(opts, identity, read);
    expect(read).toHaveBeenCalledTimes(1);
    const requests = fetch.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(requests.map((r) => r.recoverOnly === true)).toEqual([true, false, true]);
    expect(requests[1]).toMatchObject({
      expectedCurrentLicenseKey: prior,
      promotion: { expected },
    });
    expect(requests[2]).not.toHaveProperty('expectedCurrentLicenseKey');
  });
  it.each([
    new Response('{}', { status: 404 }),
    new Response('{', { status: 404 }),
    new Response('{}', { status: 503 }),
  ])('denies unproven miss before reading or minting', async (bad) => {
    const read = vi.fn(prepare);
    const fetch = vi.fn().mockResolvedValue(bad);
    vi.stubGlobal('fetch', fetch);
    await expect(promoteLicense(opts, identity, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('denies a creation status on a recover-only response before Vault access', async () => {
    const read = vi.fn(prepare);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(receipt(), 201)));
    await expect(promoteLicense(opts, identity, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('denies a recovery status on creation when no committed receipt can be recovered', async () => {
    const read = vi.fn(prepare);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(miss())
      .mockResolvedValueOnce(response(receipt(), 200))
      .mockResolvedValueOnce(miss());
    vi.stubGlobal('fetch', fetch);
    await expect(promoteLicense(opts, identity, read)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('requires explicit realm before any transport or Vault access', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const read = vi.fn(prepare);
    await expect(
      promoteLicense({ ...opts, expectedMode: undefined }, identity, read),
    ).rejects.toThrow('--mode');
    expect(fetch).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it.each([
    'mode',
    'customerId',
    'operationId',
    'action',
    'version',
  ])('rejects changed descriptor %s before Vault', async (field) => {
    const body = receipt();
    body.operation[field] = 'changed';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    await expect(promoteLicense(opts, identity, vi.fn(prepare))).rejects.toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('rotation entrypoint resumes completed promotion before calendar or Vault read', async () => {
    vaultReceipt();
    const fetch = vi.fn().mockResolvedValue(response(receipt()));
    vi.stubGlobal('fetch', fetch);
    await expect(
      rotateLicense({
        vaultPath: path,
        operationId,
        expectedMode: 'live',
        tier: 'enterprise',
        customer: 'synthetic',
        days: 90,
        perpetual: true,
        thresholdDays: 14,
        emergency: false,
      }),
    ).resolves.toMatchObject({ status: 'promoted' });
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync.mock.calls[0][1][0]).toBe('set');
  });
  it('rotation binds exact Vault whitespace separately from canonical prior token', async () => {
    const priorToken = legacyToken({
      customerId: 'synthetic',
      jti: '12345678-1234-4123-8123-123456789012',
    });
    const raw = `  ${priorToken}\n`;
    const body = receipt();
    body.operation.expectedCurrentLicenseKeySha256 = createHash('sha256')
      .update(priorToken)
      .digest('hex');
    body.operation.promotion.expected.sha256 = createHash('sha256').update(raw).digest('hex');
    const fetch = vi.fn().mockResolvedValueOnce(miss()).mockResolvedValueOnce(response(body, 201));
    vi.stubGlobal('fetch', fetch);
    vi.mocked(execFileSync)
      .mockReturnValueOnce(JSON.stringify({ path, value: raw, bytes: Buffer.byteLength(raw) }))
      .mockReturnValueOnce(
        JSON.stringify({
          operation_id: operationId,
          path,
          status: 'committed',
          current_matches: true,
        }),
      );
    await rotateLicense({
      vaultPath: path,
      operationId,
      expectedMode: 'live',
      tier: 'enterprise',
      customer: 'synthetic',
      days: 90,
      perpetual: true,
      thresholdDays: 14,
      emergency: true,
      reason: 'synthetic compromise',
    });
    const request = JSON.parse(fetch.mock.calls[1][1].body);
    expect(request.expectedCurrentLicenseKey).toBe(priorToken);
    expect(request.promotion.expected.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
  });
  it.each([
    { perpetual: false },
    { perpetual: undefined },
    { domains: ['restricted.test'] },
    { domains: null },
    { maxUsers: 9 },
    { maxSites: 9 },
  ])('rejects contradictory signed grant %j', async (extra) => {
    const body = receipt();
    body.licenseKey = legacyToken({
      customerId: 'synthetic',
      jti: operationId,
      perpetual: true,
      ...extra,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    await expect(promoteLicense(opts, identity, vi.fn(prepare))).rejects.toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('rejects dated subscription duration contradicting immutable grant', async () => {
    const body = receipt();
    const iat = Math.floor(Date.now() / 1000);
    body.operation.grant.perpetual = false;
    body.operation.grant.expiresInSeconds = 86400;
    body.operation.effectiveGrant = { ...body.operation.grant };
    body.licenseKey = legacyToken({
      customerId: 'synthetic',
      jti: operationId,
      perpetual: false,
      iat,
      exp: iat + 7200,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    await expect(
      promoteLicense({ ...opts, perpetual: false, days: 1 }, identity, vi.fn(prepare)),
    ).rejects.toThrow('signed grant duration mismatch');
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('rejects changed path and grant before Vault promotion', async () => {
    for (const change of [
      (body) => {
        body.operation.promotion.path = 'forge/customers/other/license-key';
      },
      (body) => {
        body.operation.grant.maxUsers = 1;
      },
    ]) {
      const body = receipt();
      change(body);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
      await expect(promoteLicense(opts, identity, vi.fn(prepare))).rejects.toThrow();
    }
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('accepts recorded perpetual site default without a client pricing map', async () => {
    const body = receipt();
    body.tier = 'pro';
    body.operation.grant.tier = 'pro';
    body.operation.effectiveGrant.tier = 'pro';
    body.operation.effectiveGrant.maxSites = 5;
    body.licenseKey = legacyToken({
      tier: 'pro',
      customerId: 'synthetic',
      jti: operationId,
      perpetual: true,
      maxSites: 5,
    });
    vaultReceipt();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    await expect(
      promoteLicense({ ...opts, tier: 'pro' }, identity, vi.fn(prepare)),
    ).resolves.toMatchObject({ status: 'promoted' });
  });
  it.each([0, -1, 1.5, 10001, '5'])('rejects unsupported recorded site default %j', async (cap) => {
    const body = receipt();
    body.operation.effectiveGrant.maxSites = cap;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    await expect(promoteLicense(opts, identity, vi.fn(prepare))).rejects.toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('denies signed site limit differing from recorded effective grant', async () => {
    const body = receipt();
    body.operation.effectiveGrant.maxSites = 5;
    body.licenseKey = legacyToken({
      customerId: 'synthetic',
      jti: operationId,
      perpetual: true,
      maxSites: 6,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    await expect(promoteLicense(opts, identity, vi.fn(prepare))).rejects.toThrow('signed grant');
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('rejects descriptor missing recorded effective grant rather than recomputing it', async () => {
    const body = receipt();
    delete body.operation.effectiveGrant;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    await expect(promoteLicense(opts, identity, vi.fn(prepare))).rejects.toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('accepts subscription only with exact signed duration and absent omitted limits', async () => {
    const body = receipt();
    const iat = Math.floor(Date.now() / 1000);
    body.operation.grant.perpetual = false;
    body.operation.grant.expiresInSeconds = 86400;
    body.operation.effectiveGrant = { ...body.operation.grant };
    body.licenseKey = legacyToken({
      customerId: 'synthetic',
      jti: operationId,
      perpetual: false,
      iat,
      exp: iat + 86400,
    });
    vaultReceipt();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    await expect(
      promoteLicense({ ...opts, perpetual: false, days: 1 }, identity, vi.fn(prepare)),
    ).resolves.toMatchObject({ status: 'promoted' });
  });
  it('rejects retired legacy receipt without reconstructing expectation', async () => {
    const body = receipt();
    delete body.operation;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    await expect(promoteLicense(opts, identity, vi.fn(prepare))).rejects.toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
