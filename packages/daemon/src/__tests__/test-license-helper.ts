/**
 * Test helper: generates Ed25519-signed JWT license keys for tests.
 * Creates a fresh keypair per call — no secrets needed.
 */

import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { LICENSE_API_ORIGIN } from '../license-authority.js';

export interface TestLicenseKit {
  /** Set as REVEALUI_LICENSE_KEY */
  licenseKey: string;
  /** Synthetic hosted trust key associated with this generated fixture */
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
  opts: {
    daysUntilExpiry?: number;
    customerId?: string | null;
    jti?: string | null;
    registered?: boolean;
  } = {},
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
  if (opts.registered !== false) registeredTestLicenses.set(licenseKey, payload);
  testPublicKeyByToken.set(licenseKey, publicKey as string);
  activeTestPublicKey = publicKey as string;
  return {
    licenseKey,
    publicKey: publicKey as string,
    privateKey: privateKey as string,
  };
}

/** Only explicitly generated synthetic credentials are registered by this authority fixture. */
const registeredTestLicenses = new Map<string, Record<string, unknown>>();
const testPublicKeyByToken = new Map<string, string>();
let activeTestPublicKey = '';

export function makeTestTrustManifest(publicKey: string) {
  const normalizedKey = publicKey.trim();
  const der = createPublicKey(normalizedKey).export({ format: 'der', type: 'spki' });
  const key = {
    role: 'current',
    algorithm: 'EdDSA',
    publicKey: normalizedKey,
    jwtKid: createHash('sha256').update(normalizedKey).digest('hex').slice(0, 8),
    keyId: createHash('sha256').update(der).digest('hex'),
  };
  const digestInput = JSON.stringify({
    version: 1,
    issuer: 'https://revealui.com',
    audience: 'revealui-license',
    keys: [{ role: key.role, algorithm: key.algorithm, keyId: key.keyId }],
  });
  return {
    version: 1,
    issuer: 'https://revealui.com',
    audience: 'revealui-license',
    keys: [key],
    digest: createHash('sha256').update(digestInput).digest('hex'),
    publicKey: normalizedKey,
  };
}

export function installTestLicenseAuthority(): void {
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url === `${LICENSE_API_ORIGIN}/api/license/public-key`) {
      return activeTestPublicKey
        ? Response.json(makeTestTrustManifest(activeTestPublicKey), {
            headers: { 'Cache-Control': 'no-store' },
          })
        : Response.json({ message: 'synthetic trust unavailable' }, { status: 503 });
    }
    if (url !== `${LICENSE_API_ORIGIN}/api/license/verify`) {
      return nativeFetch(input, init);
    }
    const request = JSON.parse(String(init?.body));
    const publicKey = testPublicKeyByToken.get(request.licenseKey);
    const claims = registeredTestLicenses.get(request.licenseKey);
    const currentManifest = activeTestPublicKey ? makeTestTrustManifest(activeTestPublicKey) : null;
    const signerKeyId = publicKey ? makeTestTrustManifest(publicKey).keys[0]?.keyId : undefined;
    const verifiedKeyId = currentManifest?.keys.find((key) => key.keyId === signerKeyId)?.keyId;
    if (!claims?.jti || !claims.customerId || request.requireRegistration !== true) {
      return Response.json({ valid: false, reason: 'migration_required', tier: 'free' });
    }
    if (!currentManifest || !verifiedKeyId) {
      return Response.json({ valid: false, reason: 'untrusted_signer', tier: 'free' });
    }
    return Response.json({
      valid: true,
      reason: 'valid',
      tier: claims.tier,
      customerId: claims.customerId,
      licenseKeyDigest: createHash('sha256').update(request.licenseKey).digest('hex'),
      trustSetDigest: currentManifest.digest,
      verifiedKeyId,
    });
  });
}

/**
 * Set test license env vars. Call in beforeEach/beforeAll.
 */
export function setTestLicenseEnv(kit: TestLicenseKit): void {
  process.env.REVEALUI_LICENSE_KEY = kit.licenseKey;
}

/**
 * Clear test license env vars. Call in afterEach/afterAll.
 */
export function clearTestLicenseEnv(): void {
  delete process.env.REVEALUI_LICENSE_KEY;
  const homeData = join(homedir(), '.local', 'share', 'revealui');
  if (!process.env.REVDEV_DAEMON_DATA || process.env.REVDEV_DAEMON_DATA === homeData) {
    const isolated = join(tmpdir(), 'revdev-license-isolation');
    mkdirSync(isolated, { recursive: true });
    process.env.REVDEV_DAEMON_DATA = isolated;
  }
}
