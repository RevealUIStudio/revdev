/**
 * License validation for the RevDev daemon.
 *
 * The daemon is a Pro feature — it requires a valid RevealUI Pro or
 * Enterprise license. Developer tooling commands (start, health) are
 * exempt to allow daemon lifecycle management without a license check.
 *
 * When running as a standalone daemon (outside the RevealUI monorepo),
 * license validation is done via the REVEALUI_LICENSE_KEY env var.
 *
 * License format: Ed25519-signed JWT (RFC 7519) — keys start with "eyJ".
 * Issued by the RevealUI license API or `revdev/scripts/issue-license.ts`.
 *
 * Legacy formats (RVUI.v2.*, RVUI-*) are rejected per CR8-P0-01 Q2
 * (immediate dotted-v2 removal, no deprecation window, 2026-05-04).
 */

// Import statically — same ESM module, no circular risk.
import { getVendorPublicKey, verifyLicenseJWT } from './license-crypto.js';

export const LICENSE_TIERS = ['free', 'pro', 'max', 'enterprise'] as const;
export type LicenseTier = (typeof LICENSE_TIERS)[number];

const EXEMPT_METHODS = new Set([
  'ping',
  'session.register',
  'session.update',
  'session.end',
  'session.list',
]);

/**
 * Check whether the current license allows daemon operation.
 *
 * Returns the detected tier, or 'free' if no valid license is found.
 * The daemon runs in degraded mode on free tier: session management
 * works, but spawning, inference, and merge pipeline are gated.
 */
export function checkLicense(): { tier: LicenseTier; valid: boolean } {
  const key = process.env.REVEALUI_LICENSE_KEY;

  if (!key) {
    return { tier: 'free', valid: false };
  }

  // JWT format (Ed25519-signed): header starts with base64url-encoded "{"
  if (key.startsWith('eyJ')) {
    const result = verifyLicenseJWT(key, getVendorPublicKey());
    if (result.valid) {
      return { tier: result.tier, valid: true };
    }
    if ('reason' in result) {
      process.stderr.write(`[revdev] License validation failed: ${result.reason}\n`);
    }
    return { tier: 'free', valid: false };
  }

  // Legacy formats — REJECTED outright per CR8-P0-01 Q2
  if (key.startsWith('RVUI.v2.') || key.match(/^RVUI-/i)) {
    process.stderr.write(
      '[revdev] Legacy license formats (RVUI.v2.*, RVUI-*) are no longer accepted. ' +
        'Mint an Ed25519-signed JWT via the RevealUI license API or ' +
        '`revdev/scripts/issue-license.ts`.\n',
    );
    return { tier: 'free', valid: false };
  }

  return { tier: 'free', valid: false };
}

/** Returns true if the given RPC method is exempt from license checks. */
export function isExemptMethod(method: string): boolean {
  return EXEMPT_METHODS.has(method);
}
