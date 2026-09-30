import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { guardRpcMethod } from '../guard.js';
import { verifyRegisteredLicense } from '../license-authority.js';
import {
  generateTestLicense,
  installTestLicenseAuthority,
  setTestLicenseEnv,
} from './test-license-helper.js';

afterEach(() => vi.unstubAllGlobals());

function evidence(key: string) {
  return {
    valid: true,
    reason: 'valid',
    tier: 'pro',
    customerId: 'synthetic-customer',
    licenseKeyDigest: createHash('sha256').update(key).digest('hex'),
  };
}

it('checks the fixed authority every time with no redirects or positive response cache', async () => {
  const kit = generateTestLicense('pro');
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(evidence(kit.licenseKey)))
    .mockResolvedValueOnce(Response.json({ valid: false, reason: 'revoked' }));
  expect(
    await verifyRegisteredLicense(
      kit.licenseKey,
      { tier: 'pro', customerId: 'synthetic-customer' },
      transport,
    ),
  ).toBe(true);
  expect(
    await verifyRegisteredLicense(
      kit.licenseKey,
      { tier: 'pro', customerId: 'synthetic-customer' },
      transport,
    ),
  ).toBe(false);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport).toHaveBeenCalledWith(
    'https://api.revealui.com/api/license/verify',
    expect.objectContaining({
      redirect: 'error',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    }),
  );
});

it.each([
  { valid: false },
  { licenseKeyDigest: 'different-token' },
  { customerId: 'other-customer' },
  { tier: 'enterprise' },
  { reason: 'migration_required' },
])('denies mismatched authority evidence %j', async (mismatch) => {
  const kit = generateTestLicense('pro');
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ...evidence(kit.licenseKey), ...mismatch }));
  expect(
    await verifyRegisteredLicense(
      kit.licenseKey,
      { tier: 'pro', customerId: 'synthetic-customer' },
      transport,
    ),
  ).toBe(false);
});

it('denies malformed responses, transport failure, and non-success status', async () => {
  const expected = { tier: 'pro' as const, customerId: 'synthetic-customer' };
  for (const transport of [
    vi.fn<typeof fetch>().mockResolvedValue(new Response('not-json')),
    vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 503 })),
    vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic TLS failure')),
  ])
    expect(await verifyRegisteredLicense('synthetic-token', expected, transport)).toBe(false);
});

it('denies configuration replacement while a paid request is awaiting authority', async () => {
  const original = generateTestLicense('pro');
  const replacement = generateTestLicense('pro');
  setTestLicenseEnv(original);
  vi.stubGlobal('fetch', async () => {
    setTestLicenseEnv(replacement);
    return Response.json(evidence(original.licenseKey));
  });
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(false);
});

it('requires registered identity and avoids authority calls for exempt/free dispatch', async () => {
  setTestLicenseEnv(generateTestLicense('pro', true, { jti: null }));
  const transport = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', transport);
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(false);
  expect((await guardRpcMethod('ping')).allowed).toBe(true);
  expect(transport).not.toHaveBeenCalled();
});

it('the synthetic authority denies a signed complete identity without exact registration', async () => {
  installTestLicenseAuthority();
  setTestLicenseEnv(generateTestLicense('pro', true, { registered: false }));
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(false);
});

it('restores and reinstalls exact registration without masking an explicit outage', async () => {
  const nativeFetch = globalThis.fetch;
  const kit = generateTestLicense('pro');
  setTestLicenseEnv(kit);
  installTestLicenseAuthority();
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(true);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic outage')));
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(false);
  vi.unstubAllGlobals();
  expect(globalThis.fetch).toBe(nativeFetch);
  installTestLicenseAuthority();
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(true);
});
