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
 * TODO(licensing): the current format `RVUI-<tier>-<32 hex chars>` is not
 * cryptographically bound — any regex-matching string is accepted as valid.
 * Planned upgrade: `RVUI.v2.<tier>.<expiresAt>.<ed25519-sig-base64url>` with:
 *   - Ed25519 signature over `<tier>.<expiresAt>` verified against a vendor
 *     public key baked into the daemon binary.
 *   - `expiresAt` unix timestamp; keys reject after that point.
 *   - Vendor-side key-generation CLI; signing private key stored in revvault.
 * Blocks casual forgery; determined attackers can still patch the binary,
 * but that is a separate threat model from tier-gate enforcement.
 */
export function checkLicense(): { tier: LicenseTier; valid: boolean } {
  const key = process.env.REVEALUI_LICENSE_KEY;

  if (!key) {
    return { tier: 'free', valid: false };
  }

  // License key format: RVUI-<tier>-<hash>
  const match = key.match(/^RVUI-(pro|max|enterprise)-[a-f0-9]{32}$/i);
  if (!match) {
    return { tier: 'free', valid: false };
  }

  const tier = match[1]?.toLowerCase() as LicenseTier;
  return { tier, valid: true };
}

/** Returns true if the given RPC method is exempt from license checks. */
export function isExemptMethod(method: string): boolean {
  return EXEMPT_METHODS.has(method);
}
