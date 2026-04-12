/**
 * RPC license guard — enforces runtime paywall on daemon methods.
 *
 * Free tier: session management only (register, update, end, list, ping).
 * Pro+: full access to spawning, inference, merge pipeline, memory, etc.
 *
 * This is the runtime enforcement layer. The FSL-1.1-MIT license provides
 * legal protection; this guard provides operational protection.
 */

import { checkLicense, isExemptMethod, type LicenseTier } from './license.js';

export interface RpcGuardResult {
  allowed: boolean;
  tier: LicenseTier;
  reason?: string;
}

/** Cached license state — checked once at startup, refreshable on demand. */
let cachedLicense: { tier: LicenseTier; valid: boolean } | null = null;

/**
 * Initialize license state. Call once at daemon startup.
 * Logs the detected tier as a startup banner.
 */
export function initLicenseGuard(): { tier: LicenseTier; valid: boolean } {
  cachedLicense = checkLicense();

  if (cachedLicense.valid) {
    console.log(
      `[license] RevDev daemon running with ${cachedLicense.tier.toUpperCase()} license`,
    );
  } else {
    console.log('[license] RevDev daemon running in FREE (degraded) mode');
    console.log('[license] Set REVEALUI_LICENSE_KEY to unlock Pro features');
    console.log('[license] Available: agent spawning, inference, merge pipeline, memory');
  }

  return cachedLicense;
}

/** Force a license recheck (e.g. if env var was updated). */
export function refreshLicense(): { tier: LicenseTier; valid: boolean } {
  cachedLicense = checkLicense();
  return cachedLicense;
}

/** Get current cached license state. */
export function getLicenseState(): { tier: LicenseTier; valid: boolean } {
  if (!cachedLicense) {
    cachedLicense = checkLicense();
  }
  return cachedLicense;
}

/**
 * Guard an RPC method call against the current license tier.
 *
 * Returns { allowed: true } for exempt methods and valid Pro+ licenses.
 * Returns { allowed: false, reason } for gated methods on free tier.
 */
export function guardRpcMethod(method: string): RpcGuardResult {
  const license = getLicenseState();

  // Exempt methods always pass (session management, ping)
  if (isExemptMethod(method)) {
    return { allowed: true, tier: license.tier };
  }

  // Valid Pro+ license: full access
  if (license.valid) {
    return { allowed: true, tier: license.tier };
  }

  // Free tier: blocked
  return {
    allowed: false,
    tier: 'free',
    reason: `Method "${method}" requires a Pro or higher license. ` +
      'Set REVEALUI_LICENSE_KEY or upgrade at https://revealui.com/pro',
  };
}

/**
 * JSON-RPC 2.0 error response for license violations.
 * Uses error code -32001 (server error range, license required).
 */
export function licenseErrorResponse(
  id: number | string | null,
  result: RpcGuardResult,
): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32001,
      message: 'License required',
      data: {
        tier: result.tier,
        reason: result.reason,
        upgradeUrl: 'https://revealui.com/pro',
      },
    },
  });
}
