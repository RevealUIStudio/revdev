/**
 * Ed25519 license key cryptography for RevDev.
 *
 * License format: RVUI.v2.<tier>.<expiresAt>.<signature-base64url>
 *
 * - <tier>: pro | max | enterprise
 * - <expiresAt>: unix timestamp (seconds), or "0" for perpetual
 * - <signature>: Ed25519 signature over "<tier>.<expiresAt>" in base64url
 *
 * The vendor public key is read from the REVDEV_LICENSE_PUBLIC_KEY env var
 * (also stored in revvault at `revdev/license-signing-public-key`). The
 * matching private key lives in revvault at `revdev/license-signing-private-key`
 * and is only used by the key issuing CLI (`scripts/issue-license.ts`,
 * which also has a `--generate-keypair` mode for first-time setup).
 *
 * Threat model: blocks casual forgery. Determined attackers can patch
 * the binary, but that's a separate concern from tier-gate enforcement.
 */

import { verify } from 'node:crypto';

/**
 * Vendor Ed25519 public key (PEM), read from REVDEV_LICENSE_PUBLIC_KEY at
 * call time (tests set the env var after import). To mint a fresh keypair:
 *
 *   pnpm exec tsx scripts/issue-license.ts --generate-keypair
 *
 * That writes both halves to revvault and prints the PEM-formatted public
 * key to copy into the daemon's environment / Studio bundle.
 */
function getVendorPublicKey(): string {
  return process.env.REVDEV_LICENSE_PUBLIC_KEY ?? '';
}

const VALID_TIERS = new Set(['pro', 'max', 'enterprise']);

export interface LicenseV2Result {
  tier: 'pro' | 'max' | 'enterprise';
  expiresAt: number; // unix seconds, 0 = perpetual
  valid: true;
}

export interface LicenseV2Failure {
  tier: 'free';
  valid: false;
  reason: string;
}

/**
 * Verify an Ed25519-signed license key.
 *
 * Returns the tier + expiration if valid, or { valid: false, reason } if not.
 */
export function verifyLicenseV2(key: string): LicenseV2Result | LicenseV2Failure {
  // Parse format: RVUI.v2.<tier>.<expiresAt>.<signature>
  const parts = key.split('.');
  if (parts.length !== 5 || parts[0] !== 'RVUI' || parts[1] !== 'v2') {
    return { tier: 'free', valid: false, reason: 'invalid format' };
  }

  const [, , tierStr, expiresAtStr, signatureB64] = parts;

  if (!tierStr || !VALID_TIERS.has(tierStr)) {
    return { tier: 'free', valid: false, reason: `invalid tier: ${tierStr}` };
  }

  if (!expiresAtStr || !signatureB64) {
    return { tier: 'free', valid: false, reason: 'missing fields' };
  }

  const expiresAt = parseInt(expiresAtStr, 10);
  if (Number.isNaN(expiresAt)) {
    return { tier: 'free', valid: false, reason: 'invalid expiresAt' };
  }

  // Check expiration (0 = perpetual, never expires)
  if (expiresAt > 0) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds > expiresAt) {
      return { tier: 'free', valid: false, reason: 'license expired' };
    }
  }

  // Verify Ed25519 signature
  const vendorKey = getVendorPublicKey();
  if (!vendorKey) {
    return {
      tier: 'free',
      valid: false,
      reason: 'REVDEV_LICENSE_PUBLIC_KEY not set — cannot verify signature',
    };
  }

  const message = `${tierStr}.${expiresAtStr}`;
  const signature = Buffer.from(signatureB64, 'base64url');

  try {
    // Ed25519 doesn't use a separate digest — pass null as algorithm
    const isValid = verify(null, Buffer.from(message), vendorKey, signature);

    if (!isValid) {
      return { tier: 'free', valid: false, reason: 'invalid signature' };
    }
  } catch {
    return { tier: 'free', valid: false, reason: 'signature verification failed' };
  }

  return {
    tier: tierStr as 'pro' | 'max' | 'enterprise',
    expiresAt,
    valid: true,
  };
}
