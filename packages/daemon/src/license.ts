/**
 * License validation for the RevDev daemon.
 *
 * The daemon is a Pro feature — it requires a valid RevealUI Pro or
 * Enterprise license. Developer tooling commands (start, health) are
 * exempt to allow daemon lifecycle management without a license check.
 *
 * When running as a standalone daemon (outside the RevealUI monorepo),
 * license validation is done via the REVEALUI_LICENSE_KEY env var.
 */

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
 *
 * License format:
 *   v2 (Ed25519): RVUI.v2.<tier>.<expiresAt>.<ed25519-sig-base64url>
 *   v1 (legacy):  RVUI-<tier>-<32 hex chars> — DEPRECATED, rejected
 *
 * v1 keys are no longer accepted. If you have a v1 key, contact
 * support@revealui.com for a v2 replacement.
 */
// Import verifyLicenseV2 statically — same ESM module, no circular risk.
import { verifyLicenseV2 } from './license-crypto.js';

export function checkLicense(): { tier: LicenseTier; valid: boolean } {
  const key = process.env.REVEALUI_LICENSE_KEY;

  if (!key) {
    return { tier: 'free', valid: false };
  }

  // v2 format: RVUI.v2.<tier>.<expiresAt>.<signature>
  if (key.startsWith('RVUI.v2.')) {
    const result = verifyLicenseV2(key);
    if (result.valid) {
      return { tier: result.tier, valid: true };
    }
    if ('reason' in result) {
      process.stderr.write(`[revdev] License validation failed: ${result.reason}\n`);
    }
    return { tier: 'free', valid: false };
  }

  // v1 format: RVUI-<tier>-<hash> — REJECTED (not cryptographically bound)
  if (key.match(/^RVUI-/i)) {
    process.stderr.write(
      '[revdev] v1 license keys (RVUI-<tier>-<hash>) are no longer accepted. ' +
        'Contact support@revealui.com for a v2 Ed25519-signed key.\n',
    );
    return { tier: 'free', valid: false };
  }

  return { tier: 'free', valid: false };
}

/** Returns true if the given RPC method is exempt from license checks. */
export function isExemptMethod(method: string): boolean {
  return EXEMPT_METHODS.has(method);
}
