import { expect, it } from 'vitest';
import {
  fetchLicenseTrustSet,
  LICENSE_API_ORIGIN,
  verifyRegisteredLicense,
} from '../license-authority.js';
import {
  generateTestLicense,
  installTestLicenseAuthority,
  setTestLicenseEnv,
} from './test-license-helper.js';

it('registers generated credentials with the shared suite authority using exact identity evidence', async () => {
  const kit = generateTestLicense('enterprise', true, { customerId: 'fixture-customer' });
  setTestLicenseEnv(kit);
  installTestLicenseAuthority();
  const expected = { tier: 'enterprise' as const, customerId: 'fixture-customer' };
  const trustSet = await fetchLicenseTrustSet();
  expect(trustSet).not.toBeNull();
  if (!trustSet) return;
  expect(
    await verifyRegisteredLicense(
      kit.licenseKey,
      { ...expected, verifiedKeyId: trustSet.keys[0]?.keyId ?? '' },
      trustSet,
    ),
  ).toBe(true);
  expect(
    await verifyRegisteredLicense(
      kit.licenseKey,
      { ...expected, customerId: 'other-customer', verifiedKeyId: trustSet.keys[0]?.keyId ?? '' },
      trustSet,
    ),
  ).toBe(false);
  expect(
    await verifyRegisteredLicense(
      `${kit.licenseKey}changed`,
      { ...expected, verifiedKeyId: trustSet.keys[0]?.keyId ?? '' },
      trustSet,
    ),
  ).toBe(false);
});

it('denies missing registration identity and requests without explicit registration enforcement', async () => {
  const expected = { tier: 'pro' as const, customerId: 'synthetic-customer' };
  for (const claims of [{ jti: null }, { customerId: null }]) {
    const kit = generateTestLicense('pro', true, claims);
    setTestLicenseEnv(kit);
    installTestLicenseAuthority();
    const trustSet = await fetchLicenseTrustSet();
    expect(
      await verifyRegisteredLicense(
        kit.licenseKey,
        { ...expected, verifiedKeyId: trustSet?.keys[0]?.keyId ?? '' },
        trustSet,
      ),
    ).toBe(false);
  }
  const kit = generateTestLicense('pro');
  setTestLicenseEnv(kit);
  installTestLicenseAuthority();
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
