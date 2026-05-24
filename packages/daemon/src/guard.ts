/**
 * RPC license guard — enforces runtime paywall on daemon methods.
 *
 * Free tier: session management only (register, update, end, list, ping).
 * Pro+: full access to spawning, inference, merge pipeline, memory, etc.
 *
 * This is the runtime enforcement layer. The FSL-1.1-MIT license provides
 * legal protection; this guard provides operational protection.
 *
 * Expiry behavior (GAP-184): initLicenseGuard() warns at 14d/7d/1d before
 * expiry and FAILS CLOSED (throws LicenseExpiredError) when a present
 * license is already expired — the daemon refuses to start. A license that
 * expires *while the daemon is running* is reported loudly via
 * runtimeLicenseRecheck() but does NOT tear down active sessions; the next
 * restart fails closed.
 */

import {
  checkLicense,
  evaluateLicense,
  isExemptMethod,
  type LicenseEvaluation,
  LicenseExpiredError,
  LICENSE_HELP_URL,
  type LicenseTier,
} from './license.js';
import { recordLicenseMetrics } from './observability.js';

export interface RpcGuardResult {
  allowed: boolean;
  tier: LicenseTier;
  reason?: string;
}

/** Cached license state — checked once at startup, refreshable on demand. */
let cachedLicense: { tier: LicenseTier; valid: boolean } | null = null;

/** Render a signed seconds delta as a compact human duration ("12d 3h"). */
function humanizeSeconds(seconds: number): string {
  const abs = Math.abs(seconds);
  const days = Math.floor(abs / 86_400);
  const hours = Math.floor((abs % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((abs % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

/** Log the expiry warning appropriate to a valid-but-expiring license. */
function logExpiryWarning(ev: LicenseEvaluation): void {
  if (ev.secondsRemaining === null || ev.expiresAt === null) return;
  const at = new Date(ev.expiresAt * 1000).toISOString();
  const ttl = humanizeSeconds(ev.secondsRemaining);
  const tail = `(expires ${at}, ${ttl} remaining) — rotate per ${LICENSE_HELP_URL}`;
  switch (ev.status) {
    case 'expiring-1d':
      console.error(`[license] CRITICAL: license expires in <= 1 day ${tail}`);
      break;
    case 'expiring-7d':
      console.warn(`[license] WARNING: license expires in <= 7 days ${tail}`);
      break;
    case 'expiring-14d':
      console.info(`[license] notice: license expires in <= 14 days ${tail}`);
      break;
    default:
      break;
  }
}

/**
 * Initialize license state. Call once at daemon startup.
 *
 * Logs the detected tier as a startup banner, records license metrics, warns
 * on approaching expiry, and FAILS CLOSED (throws LicenseExpiredError) when a
 * present license is already expired. Because startDaemon() calls this before
 * binding the socket or opening the database, the throw aborts startup with
 * nothing to tear down.
 */
export function initLicenseGuard(): { tier: LicenseTier; valid: boolean } {
  const ev = evaluateLicense();
  cachedLicense = { tier: ev.tier, valid: ev.valid };
  recordLicenseMetrics(ev);

  // Fail-closed: a present-but-expired credential is a security event, not
  // the same as running unlicensed (free/degraded) mode.
  if (ev.status === 'expired') {
    const ago = ev.secondsRemaining === null ? 'some time' : humanizeSeconds(ev.secondsRemaining);
    const at = ev.expiresAt ? new Date(ev.expiresAt * 1000).toISOString() : 'unknown';
    console.error(
      `[license] CRITICAL: license EXPIRED ${ago} ago (expired ${at}) — refusing to start. ` +
        `Rotate the license per ${LICENSE_HELP_URL}, then restart the daemon.`,
    );
    throw new LicenseExpiredError(
      `RevDev daemon license expired (${at}); refusing to start`,
      ev.expiresAt,
    );
  }

  if (ev.valid) {
    console.log(`[license] RevDev daemon running with ${ev.tier.toUpperCase()} license`);
    logExpiryWarning(ev);
  } else {
    console.log('[license] RevDev daemon running in FREE (degraded) mode');
    console.log('[license] Set REVEALUI_LICENSE_KEY to unlock Pro features');
    console.log('[license] Available: agent spawning, inference, merge pipeline, memory');
  }

  return cachedLicense;
}

/**
 * Re-evaluate the license while the daemon is running (called on a daily
 * timer). Refreshes metrics and logs warnings, but intentionally does NOT
 * tear down the running daemon or downgrade the cached tier — a license that
 * crosses expiry mid-session is reported loudly and fails closed on the next
 * restart, rather than disrupting in-flight agent work. Returns the fresh
 * evaluation so the caller can emit telemetry events.
 */
export function runtimeLicenseRecheck(): LicenseEvaluation {
  const ev = evaluateLicense();
  recordLicenseMetrics(ev);
  if (ev.status === 'expired') {
    const at = ev.expiresAt ? new Date(ev.expiresAt * 1000).toISOString() : 'unknown';
    console.error(
      `[license] CRITICAL: license has EXPIRED while running (expired ${at}). ` +
        `Pro features remain served until restart, which will fail closed. ` +
        `Rotate per ${LICENSE_HELP_URL}.`,
    );
  } else {
    logExpiryWarning(ev);
  }
  return ev;
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
    reason:
      `Method "${method}" requires a Pro or higher license. ` +
      'Set REVEALUI_LICENSE_KEY or upgrade at https://revealui.com/pro',
  };
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
