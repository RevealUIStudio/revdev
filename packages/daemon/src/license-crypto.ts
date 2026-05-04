/**
 * Ed25519 JWT license key cryptography for RevDev.
 *
 * License format: Ed25519-signed JWT (RFC 7519)
 *   Header: { "alg": "EdDSA", "typ": "JWT" }
 *   Payload: { tier, iat, iss, aud, customerId?, exp? }
 *
 * - tier: "pro" | "max" | "enterprise"
 * - exp: unix timestamp (seconds); absent = perpetual
 * - iss: "https://revealui.com"
 * - aud: "revealui-license"
 *
 * The vendor public key is read from the REVDEV_LICENSE_PUBLIC_KEY env var
 * (also stored in revvault at `revdev/license-signing-public-key`). The
 * matching private key lives in revvault at `revdev/license-signing-private-key`
 * and is only used by the key issuing CLI (`scripts/issue-license.ts`,
 * which also has a `--generate-keypair` mode for first-time setup).
 *
 * Verification is hand-decoded (no jose dep): split on ".", base64url-decode
 * header+payload, assert alg=EdDSA, verify Ed25519 signature over the raw
 * "<headerB64url>.<payloadB64url>" bytes via node:crypto.verify(null, ...).
 *
 * Threat model: blocks casual forgery. Determined attackers can patch
 * the binary, but that's a separate concern from tier-gate enforcement.
 *
 * Per CR8-P0-01 spec (Phase B), ships after Phase A revealui#735.
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
export function getVendorPublicKey(): string {
  return process.env.REVDEV_LICENSE_PUBLIC_KEY ?? '';
}

const VALID_TIERS = new Set(['pro', 'max', 'enterprise']);

export interface LicenseJWTResult {
  tier: 'pro' | 'max' | 'enterprise';
  expiresAt: number; // unix seconds, 0 = perpetual
  valid: true;
}

export interface LicenseJWTFailure {
  tier: 'free';
  valid: false;
  reason: string;
}

function decodeBase64url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

/**
 * Verify an Ed25519-signed JWT license key.
 *
 * Returns the tier + expiration if valid, or { valid: false, reason } if not.
 * Never throws — all parse/verify errors are returned as failures.
 */
export function verifyLicenseJWT(
  token: string,
  publicKey: string,
): LicenseJWTResult | LicenseJWTFailure {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { tier: 'free', valid: false, reason: 'invalid format' };
    }

    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    // Decode + parse header
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(decodeBase64url(headerB64).toString('utf-8')) as Record<string, unknown>;
    } catch {
      return { tier: 'free', valid: false, reason: 'invalid format' };
    }

    if (header.alg !== 'EdDSA') {
      return { tier: 'free', valid: false, reason: 'unsupported algorithm' };
    }

    // Decode + parse payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(decodeBase64url(payloadB64).toString('utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      return { tier: 'free', valid: false, reason: 'invalid format' };
    }

    // Validate tier
    const tier = payload.tier;
    if (typeof tier !== 'string' || !VALID_TIERS.has(tier)) {
      return { tier: 'free', valid: false, reason: `invalid tier: ${String(tier)}` };
    }

    // Validate exp (absent = perpetual; present = must be a number)
    const exp = payload.exp;
    if (exp !== undefined && typeof exp !== 'number') {
      return { tier: 'free', valid: false, reason: 'invalid exp claim' };
    }

    // Check expiration if exp is present
    if (typeof exp === 'number') {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds > exp) {
        return { tier: 'free', valid: false, reason: 'license expired' };
      }
    }

    if (!publicKey) {
      return {
        tier: 'free',
        valid: false,
        reason: 'REVDEV_LICENSE_PUBLIC_KEY not set — cannot verify signature',
      };
    }

    // The signed message is the literal "<headerB64url>.<payloadB64url>" string
    const message = `${headerB64}.${payloadB64}`;
    const signatureBuffer = decodeBase64url(signatureB64);

    // Ed25519 doesn't use a separate digest — pass null as algorithm
    const isValid = verify(null, Buffer.from(message, 'utf-8'), publicKey, signatureBuffer);

    if (!isValid) {
      return { tier: 'free', valid: false, reason: 'invalid signature' };
    }

    // expiresAt: 0 = perpetual (mirrors dotted-v2 semantics)
    const expiresAt = typeof exp === 'number' ? exp : 0;

    return {
      tier: tier as 'pro' | 'max' | 'enterprise',
      expiresAt,
      valid: true,
    };
  } catch {
    return { tier: 'free', valid: false, reason: 'invalid format' };
  }
}
