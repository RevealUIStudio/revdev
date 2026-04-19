/**
 * Test helper: generates Ed25519-signed v2 license keys for tests.
 * Creates a fresh keypair per call — no secrets needed.
 */

import { generateKeyPairSync, sign } from 'node:crypto';

export interface TestLicenseKit {
  /** Set as REVEALUI_LICENSE_KEY */
  licenseKey: string;
  /** Set as REVDEV_LICENSE_PUBLIC_KEY */
  publicKey: string;
}

/**
 * Generate a real Ed25519-signed v2 license key for testing.
 * Returns both the key and the public key to set in env.
 */
export function generateTestLicense(
  tier: 'pro' | 'max' | 'enterprise' = 'enterprise',
  perpetual = true,
): TestLicenseKit {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const expiresAt = perpetual ? '0' : String(Math.floor(Date.now() / 1000) + 86400);
  const message = `${tier}.${expiresAt}`;
  const sig = sign(null, Buffer.from(message), privateKey).toString('base64url');

  return {
    licenseKey: `RVUI.v2.${tier}.${expiresAt}.${sig}`,
    publicKey: publicKey as string,
  };
}

/**
 * Set test license env vars. Call in beforeEach/beforeAll.
 */
export function setTestLicenseEnv(kit: TestLicenseKit): void {
  process.env.REVEALUI_LICENSE_KEY = kit.licenseKey;
  process.env.REVDEV_LICENSE_PUBLIC_KEY = kit.publicKey;
}

/**
 * Clear test license env vars. Call in afterEach/afterAll.
 */
export function clearTestLicenseEnv(): void {
  delete process.env.REVEALUI_LICENSE_KEY;
  delete process.env.REVDEV_LICENSE_PUBLIC_KEY;
}
