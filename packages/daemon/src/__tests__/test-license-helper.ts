/**
 * Test helper: generates Ed25519-signed JWT license keys for tests.
 * Creates a fresh keypair per call — no secrets needed.
 */

import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { LICENSE_API_ORIGIN } from '../license-authority.js';

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
  opts: { daysUntilExpiry?: number; customerId?: string | null; jti?: string | null } = {},
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

  if (opts.jti !== null) payload.jti = opts.jti ?? randomUUID();

  if (opts.customerId !== null) {
    payload.customerId = opts.customerId ?? 'synthetic-customer';
  }

  if (!perpetual) {
    payload.exp = now + (opts.daysUntilExpiry ?? 1) * 86400;
  }

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${headerB64}.${payloadB64}`;
  const sig = sign(null, Buffer.from(message), privateKey).toString('base64url');

  const licenseKey = `${message}.${sig}`;
  registeredTestLicenses.set(licenseKey, payload);
  return {
    licenseKey,
    publicKey: publicKey as string,
    privateKey: privateKey as string,
  };
}

/** Only explicitly generated synthetic credentials are registered by this authority fixture. */
const registeredTestLicenses = new Map<string, Record<string, unknown>>();

export function installTestLicenseAuthority(): void {
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== `${LICENSE_API_ORIGIN}/api/license/verify`) {
      return nativeFetch(input, init);
    }
    const request = JSON.parse(String(init?.body));
    const claims = registeredTestLicenses.get(request.licenseKey);
    if (!claims?.jti || !claims.customerId || request.requireRegistration !== true) {
      return Response.json({ valid: false, reason: 'migration_required', tier: 'free' });
    }
    return Response.json({
      valid: true,
      reason: 'valid',
      tier: claims.tier,
      customerId: claims.customerId,
      licenseKeyDigest: createHash('sha256').update(request.licenseKey).digest('hex'),
    });
  });
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
  const homeData = join(homedir(), '.local', 'share', 'revealui');
  if (!process.env.REVDEV_DAEMON_DATA || process.env.REVDEV_DAEMON_DATA === homeData) {
    const isolated = join(tmpdir(), 'revdev-license-isolation');
    mkdirSync(isolated, { recursive: true });
    process.env.REVDEV_DAEMON_DATA = isolated;
  }
}
