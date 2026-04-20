/**
 * License validation for the RevDev daemon.
 *
 * Delegates to @revealui/core/license for RS256 JWT verification with:
 *   - Cryptographic signature validation (vendor public key)
 *   - Expiration + grace period enforcement
 *   - Tier-based feature gating
 *   - Encrypted key support (AES-256-GCM)
 *
 * The daemon runs in degraded mode on free tier: session management
 * works, but spawning, inference, and merge pipeline are gated.
 */

import { isFeatureEnabled } from '@revealui/core/features';
import {
  getCurrentTier,
  initializeLicense,
  isLicensed,
  type LicenseTier,
} from '@revealui/core/license';

export type { LicenseTier };
export const LICENSE_TIERS = ['free', 'pro', 'max', 'enterprise'] as const;

/** Methods that never require a license (session lifecycle + health). */
const EXEMPT_METHODS = new Set([
  'ping',
  'session.register',
  'session.attach',
  'session.update',
  'session.end',
  'session.list',
  'harness.health',
]);

/**
 * Feature-to-method mapping. Each daemon RPC method is gated by a feature flag
 * rather than a blanket "Pro+" check. This allows tier-specific access control.
 */
const METHOD_FEATURE_MAP: Record<string, keyof import('@revealui/core/features').FeatureFlags> = {
  'inference.status': 'aiInference',
  'inference.pull': 'aiInference',
  'inference.start': 'aiInference',
  'inference.stop': 'aiInference',
  'inference.chat': 'aiInference',
  'inference.generate': 'aiInference',
  'memory.store': 'aiMemory',
  'memory.query': 'aiMemory',
};

/**
 * Initialize the license system. Must be called once at daemon startup.
 * Returns the detected tier for logging.
 */
export async function initDaemonLicense(): Promise<LicenseTier> {
  return await initializeLicense();
}

/**
 * Check whether the current license allows daemon operation.
 * Wraps @revealui/core for backward compat with existing guard.ts.
 */
export function checkLicense(): { tier: LicenseTier; valid: boolean } {
  const tier = getCurrentTier();
  const valid = isLicensed('pro');
  return { tier, valid };
}

/** Returns true if the given RPC method is exempt from license checks. */
export function isExemptMethod(method: string): boolean {
  return EXEMPT_METHODS.has(method);
}

/**
 * Check if a specific method is allowed by the current license tier.
 * Uses feature flags for granular gating where a mapping exists,
 * falls back to Pro+ requirement for unmapped methods.
 */
export function isMethodAllowed(method: string): boolean {
  if (isExemptMethod(method)) return true;

  const feature = METHOD_FEATURE_MAP[method];
  if (feature) {
    return isFeatureEnabled(feature);
  }

  // Default: require Pro+ for any non-exempt, non-mapped method
  return isLicensed('pro');
}
