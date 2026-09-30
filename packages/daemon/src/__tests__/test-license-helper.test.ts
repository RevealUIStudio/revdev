import { expect, it } from 'vitest';
import { LICENSE_API_ORIGIN, verifyRegisteredLicense } from '../license-authority.js';
import { generateTestLicense } from './test-license-helper.js';

it('registers generated credentials with the shared suite authority using exact identity evidence', async () => {
  const kit = generateTestLicense('enterprise', true, { customerId: 'fixture-customer' });
  const expected = { tier: 'enterprise' as const, customerId: 'fixture-customer' };
  expect(await verifyRegisteredLicense(kit.licenseKey, expected)).toBe(true);
  expect(
    await verifyRegisteredLicense(kit.licenseKey, { ...expected, customerId: 'other-customer' }),
  ).toBe(false);
  expect(await verifyRegisteredLicense(`${kit.licenseKey}changed`, expected)).toBe(false);
});

it('denies missing registration identity and requests without explicit registration enforcement', async () => {
  const expected = { tier: 'pro' as const, customerId: 'synthetic-customer' };
  for (const claims of [{ jti: null }, { customerId: null }]) {
    const kit = generateTestLicense('pro', true, claims);
    expect(await verifyRegisteredLicense(kit.licenseKey, expected)).toBe(false);
  }
  const kit = generateTestLicense('pro');
  const response = await fetch(`${LICENSE_API_ORIGIN}/api/license/verify`, {
    method: 'POST',
    body: JSON.stringify({ licenseKey: kit.licenseKey }),
  });
  expect(await response.json()).toMatchObject({ valid: false, reason: 'migration_required' });
});

it('preserves fetch behavior outside the fixed license authority endpoint', async () => {
  const response = await fetch('data:text/plain,synthetic-non-license-response');
  expect(await response.text()).toBe('synthetic-non-license-response');
});
