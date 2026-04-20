/**
 * RPC license guard — enforces runtime paywall on daemon methods.
 *
 * Uses @revealui/core for RS256 JWT verification + feature flags.
 * Free tier: session management only (register, update, end, list, ping).
 * Pro+: feature-gated access based on tier (inference=max, memory=max, etc.).
 *
 * This is the runtime enforcement layer. The FSL-1.1-MIT license provides
 * legal protection; this guard provides operational protection.
 */

import { getCurrentTier, initializeLicense, isLicensed } from '@revealui/core/license';
import { checkLicense, initDaemonLicense, isMethodAllowed, type LicenseTier } from './license.js';

export interface RpcGuardResult {
  allowed: boolean;
  tier: LicenseTier;
  reason?: string;
}

/**
 * Initialize license state. Call once at daemon startup.
 * Performs async JWT verification, then logs the tier banner.
 */
export async function initLicenseGuard(): Promise<{ tier: LicenseTier; valid: boolean }> {
  const tier = await initDaemonLicense();
  const { valid } = checkLicense();
  return { tier, valid };
}

/**
 * Guard an RPC method call against the current license tier and feature flags.
 *
 * Returns { allowed: true } for exempt methods and methods the tier grants.
 * Returns { allowed: false, reason } for gated methods on insufficient tier.
 */
export function guardRpcMethod(method: string): RpcGuardResult {
  const tier = getCurrentTier();

  if (isMethodAllowed(method)) {
    return { allowed: true, tier };
  }

  return {
    allowed: false,
    tier,
    reason:
      `Method "${method}" requires a higher license tier. ` +
      'Set REVEALUI_LICENSE_KEY or upgrade at https://revealui.com/pro',
  };
}

/** Force a license recheck (e.g. if env var was updated at runtime). */
export async function refreshLicense(): Promise<{ tier: LicenseTier; valid: boolean }> {
  const tier = await initializeLicense();
  return { tier, valid: isLicensed('pro') };
}

/** Get current cached license state (synchronous after init). */
export function getLicenseState(): { tier: LicenseTier; valid: boolean } {
  return checkLicense();
}

/**
 * JSON-RPC 2.0 error response for license violations.
 * Uses error code -32001 (server error range, license required).
 */
export function licenseErrorResponse(id: number | string | null, result: RpcGuardResult): string {
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
