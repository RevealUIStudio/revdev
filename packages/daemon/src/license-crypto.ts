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
 * Issuance uses the authenticated hosted licensing API. Verification keys
 * come only from the validated fixed-origin hosted trust manifest; this module
 * never loads a private key or generates an independent issuer keypair.
 * Local signature validation alone does not authorize paid dispatch: the
 * guard also requires exact current hosted registration before each request.
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
import { getAcceptedLicenseTrustSet, type LicenseTrustKey } from './license-authority.js';
import { isRevokedJti, revokedJtiPath, revokeJti } from './revoked-jtis.js';

export { isRevokedJti, revokedJtiPath, revokeJti };

/**
 * Current hosted Ed25519 public key (PEM), when a fresh trust set is loaded.
 *
 * Trust is supplied only by the validated fixed-origin hosted manifest held
 * in memory for the current daemon lifecycle. No baked key or machine override
 * can establish issuer trust.
 */
export function getVendorPublicKeys(): readonly LicenseTrustKey[] {
  return getAcceptedLicenseTrustSet()?.keys ?? [];
}

const VALID_TIERS = new Set(['pro', 'max', 'enterprise']);

const EXPECTED_ISS = 'https://revealui.com';
const EXPECTED_AUD = 'revealui-license';

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
  | 'revoked'
  | 'revocation-unavailable';

export interface LicenseJWTResult {
  tier: 'pro' | 'max' | 'enterprise';
  expiresAt: number; // unix seconds, 0 = perpetual
  valid: true;
  verifiedKeyId?: string;
  customerId?: string;
  jti?: string;
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
function verifyLicenseJWTInternal(
  token: string,
  publicKey: string | readonly (string | Pick<LicenseTrustKey, 'publicKey' | 'keyId'>)[],
  allowExpiredForRotation: boolean,
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
    if (exp !== undefined && (!Number.isSafeInteger(exp) || typeof exp !== 'number')) {
      return { tier: 'free', valid: false, reason: 'invalid exp claim', code: 'invalid-claim' };
    }

    const iat = payload.iat;
    if (iat !== undefined && (typeof iat !== 'number' || !Number.isSafeInteger(iat))) {
      return { tier: 'free', valid: false, reason: 'invalid iat claim', code: 'invalid-claim' };
    }
    const customerId = payload.customerId;
    if (
      customerId !== undefined &&
      (typeof customerId !== 'string' || !customerId.trim() || customerId !== customerId.trim())
    ) {
      return {
        tier: 'free',
        valid: false,
        reason: 'invalid customerId claim',
        code: 'invalid-claim',
      };
    }
    const jti = payload.jti;
    if (jti !== undefined && (typeof jti !== 'string' || !jti.trim() || jti !== jti.trim())) {
      return { tier: 'free', valid: false, reason: 'invalid jti claim', code: 'invalid-claim' };
    }

    const candidates =
      typeof publicKey === 'string'
        ? publicKey
          ? [{ publicKey }]
          : []
        : publicKey.map((candidate) =>
            typeof candidate === 'string' ? { publicKey: candidate } : candidate,
          );
    if (candidates.length === 0 || candidates.some(({ publicKey: pem }) => !pem)) {
      return {
        tier: 'free',
        valid: false,
        reason: 'Hosted license trust is not loaded — cannot verify signature',
        code: 'no-public-key',
      };
    }

    // The signed message is the literal "<headerB64url>.<payloadB64url>" string
    const message = `${headerB64}.${payloadB64}`;
    const signatureBuffer = decodeBase64url(signatureB64);

    // Ed25519 doesn't use a separate digest — pass null as algorithm
    let verifiedKeyId: string | undefined;
    let isValid = false;
    for (const candidate of candidates) {
      try {
        if (verify(null, Buffer.from(message, 'utf-8'), candidate.publicKey, signatureBuffer)) {
          isValid = true;
          if ('keyId' in candidate) verifiedKeyId = candidate.keyId;
          break;
        }
      } catch {
        // A malformed candidate cannot establish trust; try other validated entries.
      }
    }

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
      if (typeof nbf !== 'number' || !Number.isSafeInteger(nbf)) {
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
    try {
      // Validate the existing store even for legacy tokens without a JTI, so
      // corruption never silently grants paid authorization.
      if (isRevokedJti(typeof jti === 'string' ? jti : '')) {
        return { tier: 'free', valid: false, reason: 'token has been revoked', code: 'revoked' };
      }
    } catch {
      return {
        tier: 'free',
        valid: false,
        reason: 'local revocation state unavailable',
        code: 'revocation-unavailable',
      };
    }

    // Temporal expiration check — performed AFTER signature + iss + aud + nbf
    // verification so forged tokens can't trigger the daemon's
    // fail-closed-on-expired path via a backdated `exp` claim.
    if (typeof exp === 'number') {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds >= exp && !allowExpiredForRotation) {
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
      ...(verifiedKeyId ? { verifiedKeyId } : {}),
      ...(typeof customerId === 'string' ? { customerId } : {}),
      ...(typeof jti === 'string' ? { jti } : {}),
    };
  } catch {
    return { tier: 'free', valid: false, reason: 'invalid format', code: 'invalid-format' };
  }
}

export function verifyLicenseJWT(
  token: string,
  publicKey: string | readonly (string | Pick<LicenseTrustKey, 'publicKey' | 'keyId'>)[],
): LicenseJWTResult | LicenseJWTFailure {
  return verifyLicenseJWTInternal(token, publicKey, false);
}

/** Rotation-only shared verification: permits expiry while retaining all other checks. */
export function verifyLicenseJWTForPriorRotation(
  token: string,
  publicKey: readonly (string | Pick<LicenseTrustKey, 'publicKey' | 'keyId'>)[],
): LicenseJWTResult | LicenseJWTFailure {
  return verifyLicenseJWTInternal(token, publicKey, true);
}
