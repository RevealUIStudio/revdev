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
import { DEFAULT_VENDOR_PUBLIC_KEY } from './vendor-public-key.js';

/**
 * Vendor Ed25519 public key (PEM) used to verify license JWTs.
 *
 * Falls back to the baked-in DEFAULT_VENDOR_PUBLIC_KEY so activation succeeds
 * with only REVEALUI_LICENSE_KEY set (no second env var on the happy path).
 * REVDEV_LICENSE_PUBLIC_KEY overrides the default for key rotation or testing;
 * an empty/whitespace override is treated as unset and falls back to the default.
 * To mint a fresh keypair:
 *
 *   pnpm exec tsx scripts/issue-license.ts --generate-keypair
 *
 * That writes both halves to revvault and prints the PEM-formatted public key;
 * refresh DEFAULT_VENDOR_PUBLIC_KEY (in vendor-public-key.ts) on rotation.
 */
export function getVendorPublicKey(): string {
  const override = process.env.REVDEV_LICENSE_PUBLIC_KEY;
  return override && override.trim() ? override : DEFAULT_VENDOR_PUBLIC_KEY;
}

const VALID_TIERS = new Set(['pro', 'max', 'enterprise']);

const EXPECTED_ISS = 'https://revealui.com';
const EXPECTED_AUD = 'revealui-license';

// hook for future revocation channel
export function isRevokedJti(_jti: string): boolean {
  return false;
}

/**
 * Machine-readable reason a verification failed. Lets callers branch on
 * the failure class (e.g. fail-closed on `expired` while degrading to free
 * tier on `invalid-signature`) without string-matching the human `reason`.
 */
export type LicenseFailureCode =
  | 'invalid-format'
  | 'unsupported-algorithm'
  | 'invalid-tier'
  | 'invalid-claim'
  | 'expired'
  | 'not-yet-valid'
  | 'no-public-key'
  | 'invalid-signature'
  | 'invalid-issuer'
  | 'invalid-audience'
  | 'revoked';

export interface LicenseJWTResult {
  tier: 'pro' | 'max' | 'enterprise';
  expiresAt: number; // unix seconds, 0 = perpetual
  valid: true;
}

export interface LicenseJWTFailure {
  tier: 'free';
  valid: false;
  reason: string;
  code: LicenseFailureCode;
  /**
   * Present when the token parsed far enough to read its `exp` claim — set
   * on the `expired` failure so callers can report time-since-expiry and
   * drive expiry telemetry without re-decoding the token.
   */
  expiresAt?: number;
}

function decodeBase64url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

/**
 * Verify an Ed25519-signed JWT license key.
 *
 * Returns the tier + expiration if valid, or { valid: false, reason, code }
 * if not. Never throws — all parse/verify errors are returned as failures.
 */
export function verifyLicenseJWT(
  token: string,
  publicKey: string,
): LicenseJWTResult | LicenseJWTFailure {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { tier: 'free', valid: false, reason: 'invalid format', code: 'invalid-format' };
    }

    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    // Decode + parse header
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(decodeBase64url(headerB64).toString('utf-8')) as Record<string, unknown>;
    } catch {
      return { tier: 'free', valid: false, reason: 'invalid format', code: 'invalid-format' };
    }

    if (header.alg !== 'EdDSA') {
      return {
        tier: 'free',
        valid: false,
        reason: 'unsupported algorithm',
        code: 'unsupported-algorithm',
      };
    }

    // Decode + parse payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(decodeBase64url(payloadB64).toString('utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      return { tier: 'free', valid: false, reason: 'invalid format', code: 'invalid-format' };
    }

    // Validate tier
    const tier = payload.tier;
    if (typeof tier !== 'string' || !VALID_TIERS.has(tier)) {
      return {
        tier: 'free',
        valid: false,
        reason: `invalid tier: ${String(tier)}`,
        code: 'invalid-tier',
      };
    }

    // Validate exp claim shape (absent = perpetual; present = must be a number).
    // The temporal `now > exp` comparison is deferred until AFTER signature
    // verification so a forged token with a past `exp` returns 'invalid-signature'
    // (degrade-to-free) rather than 'expired' (which the daemon maps to
    // fail-closed startup). See evaluateLicense() in license.ts.
    const exp = payload.exp;
    if (exp !== undefined && typeof exp !== 'number') {
      return { tier: 'free', valid: false, reason: 'invalid exp claim', code: 'invalid-claim' };
    }

    if (!publicKey) {
      return {
        tier: 'free',
        valid: false,
        reason: 'REVDEV_LICENSE_PUBLIC_KEY not set — cannot verify signature',
        code: 'no-public-key',
      };
    }

    // The signed message is the literal "<headerB64url>.<payloadB64url>" string
    const message = `${headerB64}.${payloadB64}`;
    const signatureBuffer = decodeBase64url(signatureB64);

    // Ed25519 doesn't use a separate digest — pass null as algorithm
    const isValid = verify(null, Buffer.from(message, 'utf-8'), publicKey, signatureBuffer);

    if (!isValid) {
      return {
        tier: 'free',
        valid: false,
        reason: 'invalid signature',
        code: 'invalid-signature',
      };
    }

    // Validate iss
    if (payload.iss !== EXPECTED_ISS) {
      return {
        tier: 'free',
        valid: false,
        reason: `invalid iss: ${String(payload.iss)}`,
        code: 'invalid-issuer',
      };
    }

    // Validate aud (jose sets aud as an array or scalar; issuer uses scalar)
    const aud = payload.aud;
    const audValue = Array.isArray(aud) ? aud[0] : aud;
    if (audValue !== EXPECTED_AUD) {
      return {
        tier: 'free',
        valid: false,
        reason: `invalid aud: ${String(aud)}`,
        code: 'invalid-audience',
      };
    }

    // Validate nbf if present
    const nbf = payload.nbf;
    if (nbf !== undefined) {
      if (typeof nbf !== 'number') {
        return { tier: 'free', valid: false, reason: 'invalid nbf claim', code: 'invalid-claim' };
      }
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds < nbf) {
        return {
          tier: 'free',
          valid: false,
          reason: 'token not yet valid (nbf)',
          code: 'not-yet-valid',
        };
      }
    }

    // Check jti revocation
    const jti = payload.jti;
    if (typeof jti === 'string' && isRevokedJti(jti)) {
      return { tier: 'free', valid: false, reason: 'token has been revoked', code: 'revoked' };
    }

    // Temporal expiration check — performed AFTER signature + iss + aud + nbf
    // verification so forged tokens can't trigger the daemon's
    // fail-closed-on-expired path via a backdated `exp` claim.
    if (typeof exp === 'number') {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds > exp) {
        // Carry expiresAt so callers can compute time-since-expiry + drive
        // fail-closed / telemetry without re-decoding the token.
        return {
          tier: 'free',
          valid: false,
          reason: 'license expired',
          code: 'expired',
          expiresAt: exp,
        };
      }
    }

    // expiresAt: 0 = perpetual (mirrors dotted-v2 semantics)
    const expiresAt = typeof exp === 'number' ? exp : 0;

    return {
      tier: tier as 'pro' | 'max' | 'enterprise',
      expiresAt,
      valid: true,
    };
  } catch {
    return { tier: 'free', valid: false, reason: 'invalid format', code: 'invalid-format' };
  }
}
