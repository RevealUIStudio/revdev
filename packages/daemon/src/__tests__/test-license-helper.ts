/**
 * Test helper: generates Ed25519-signed JWT license keys for tests.
 * Creates a fresh keypair per call — no secrets needed.
 */

import { generateKeyPairSync, sign } from 'node:crypto';

export interface TestLicenseKit {
  /** Set as REVEALUI_LICENSE_KEY */
  licenseKey: string;
  /** Set as REVDEV_LICENSE_PUBLIC_KEY */
  publicKey: string;
  /** The private key PEM — available for constructing adversarial fixtures */
  privateKey: string;
}

/**
 * Generate a real Ed25519-signed JWT license key for testing.
 * Returns both the key and the public key to set in env.
 *
 * opts.daysUntilExpiry: if set, JWT includes an exp claim that far in the future.
 * perpetual (default true): JWT omits exp claim.
 */
export function generateTestLicense(
  tier: 'pro' | 'max' | 'enterprise' = 'enterprise',
  perpetual = true,
  opts: { daysUntilExpiry?: number; customerId?: string } = {},
): TestLicenseKit {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT' };
  const payload: Record<string, unknown> = {
    tier,
    iat: now,
    iss: 'https://revealui.com',
    aud: 'revealui-license',
  };

  if (opts.customerId) {
    payload['customerId'] = opts.customerId;
  }

  if (!perpetual) {
    payload['exp'] = now + (opts.daysUntilExpiry ?? 1) * 86400;
  }

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${headerB64}.${payloadB64}`;
  const sig = sign(null, Buffer.from(message), privateKey).toString('base64url');

  return {
    licenseKey: `${message}.${sig}`,
    publicKey: publicKey as string,
    privateKey: privateKey as string,
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
