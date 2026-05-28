/**
 * License validation for the RevDev daemon.
 *
 * The daemon is a Pro feature — it requires a valid RevealUI Pro or
 * Enterprise license. Developer tooling commands (start, health) are
 * exempt to allow daemon lifecycle management without a license check.
 *
 * When running as a standalone daemon (outside the RevealUI monorepo),
 * license validation is done via the REVEALUI_LICENSE_KEY env var, or
 * REVEALUI_LICENSE_KEY_FILE (a path whose contents hold the key — lets a
 * systemd-user unit decrypt the JWT to a tmpfs file + shred it post-stop,
 * avoiding env-var persistence in the process environment).
 *
 * License format: Ed25519-signed JWT (RFC 7519) — keys start with "eyJ".
 * Issued by the RevealUI license API or `revdev/scripts/issue-license.ts`.
 *
 * Legacy formats (RVUI.v2.*, RVUI-*) are rejected per CR8-P0-01 Q2
 * (immediate dotted-v2 removal, no deprecation window, 2026-05-04).
 *
 * Expiry posture (GAP-184):
 *   - No license at all      → FREE (degraded) mode. The daemon runs;
 *     session management works, Pro features are gated. (Unchanged.)
 *   - Present + valid         → licensed; warn at 14d / 7d / 1d to expiry.
 *   - Present + EXPIRED       → fail-closed: the daemon refuses to start.
 *     An expired credential is a security event, not "no license."
 *   - Present + invalid sig   → FREE (degraded). Could be a typo; loud log.
 *   - KEY_FILE set but unread → LicenseConfigError (operator pointed at a
 *     broken path — surface it loudly, don't silently degrade).
 */

import { readFileSync } from 'node:fs';
// Import statically — same ESM module, no circular risk.
import { getVendorPublicKey, verifyLicenseJWT } from './license-crypto.js';

export const LICENSE_TIERS = ['free', 'pro', 'max', 'enterprise'] as const;
export type LicenseTier = (typeof LICENSE_TIERS)[number];

/**
 * Customer-facing pointer for expiry/rotation guidance. Kept generic (no
 * internal repo paths) because the daemon is a source-visible Pro artifact
 * that customers self-host.
 */
export const LICENSE_HELP_URL = 'https://revealui.com/docs/licensing';

/** Thrown when REVEALUI_LICENSE_KEY_FILE is set but its contents are unusable. */
export class LicenseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenseConfigError';
  }
}

/** Thrown at startup when a license is present but its `exp` is in the past. */
export class LicenseExpiredError extends Error {
  readonly expiresAt: number | null;
  constructor(message: string, expiresAt: number | null) {
    super(message);
    this.name = 'LicenseExpiredError';
    this.expiresAt = expiresAt;
  }
}

const EXEMPT_METHODS = new Set([
  'ping',
  'session.register',
  'session.update',
  'session.end',
  'session.list',
]);

const DAY_SECONDS = 86_400;

export type LicenseKeySource = 'env' | 'file' | 'none';

/**
 * Resolve the license key from the environment.
 *
 * Priority: REVEALUI_LICENSE_KEY (inline) > REVEALUI_LICENSE_KEY_FILE (path).
 * Returns { key: null } when neither is set (→ free/degraded mode). Throws
 * LicenseConfigError when KEY_FILE is set but its contents can't be read or
 * are empty — a configured-but-broken file is an operator error, not the
 * same as "no license."
 */
export function loadLicenseKey(): { key: string | null; source: LicenseKeySource } {
  const inline = process.env.REVEALUI_LICENSE_KEY;
  if (inline) {
    return { key: inline, source: 'env' };
  }

  const filePath = process.env.REVEALUI_LICENSE_KEY_FILE;
  if (filePath) {
    let contents: string;
    try {
      contents = readFileSync(filePath, 'utf-8').trim();
    } catch (err) {
      throw new LicenseConfigError(
        `REVEALUI_LICENSE_KEY_FILE is set to "${filePath}" but could not be read: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    if (!contents) {
      throw new LicenseConfigError(`REVEALUI_LICENSE_KEY_FILE ("${filePath}") is empty`);
    }
    return { key: contents, source: 'file' };
  }

  return { key: null, source: 'none' };
}

/**
 * Check whether the current license allows daemon operation.
 *
 * Returns the detected tier, or 'free' if no valid license is found.
 * The daemon runs in degraded mode on free tier: session management
 * works, but spawning, inference, and merge pipeline are gated.
 *
 * Kept as the stable {tier, valid} shape consumed by the RPC guard. The
 * richer expiry-aware view is `evaluateLicense()`.
 */
export function checkLicense(): { tier: LicenseTier; valid: boolean } {
  const { key } = loadLicenseKey();

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
  if (key.startsWith('RVUI.v2.') || key.toUpperCase().startsWith('RVUI-')) {
    process.stderr.write(
      '[revdev] Legacy license formats (RVUI.v2.*, RVUI-*) are no longer accepted. ' +
        'Mint an Ed25519-signed JWT via the RevealUI license API or ' +
        '`revdev/scripts/issue-license.ts`.\n',
    );
    return { tier: 'free', valid: false };
  }

  return { tier: 'free', valid: false };
}

/** Coarse lifecycle status of the resolved license, expiry-aware. */
export type LicenseStatus =
  | 'absent' // no key set → free/degraded
  | 'invalid' // key present but failed verification (not expiry)
  | 'expired' // key present, parsed, past its exp → fail-closed
  | 'perpetual' // valid, no exp claim
  | 'ok' // valid, > 14 days to expiry
  | 'expiring-14d' // valid, <= 14 days to expiry
  | 'expiring-7d' // valid, <= 7 days to expiry
  | 'expiring-1d'; // valid, <= 1 day to expiry

export interface LicenseEvaluation {
  tier: LicenseTier;
  valid: boolean;
  /** A key was resolved from env or file (vs. none set). */
  present: boolean;
  source: LicenseKeySource;
  status: LicenseStatus;
  /** Unix seconds; null = perpetual or not determinable. */
  expiresAt: number | null;
  /** Seconds until expiry (negative if expired); null = perpetual/unknown. */
  secondsRemaining: number | null;
  reason?: string;
}

/**
 * Full expiry-aware evaluation of the resolved license. Single source of
 * truth for the startup guard's warn/fail-closed decisions + telemetry.
 *
 * `nowMs` is injectable for deterministic tests.
 */
export function evaluateLicense(nowMs: number = Date.now()): LicenseEvaluation {
  const { key, source } = loadLicenseKey(); // may throw LicenseConfigError
  const nowSeconds = Math.floor(nowMs / 1000);

  if (!key) {
    return {
      tier: 'free',
      valid: false,
      present: false,
      source,
      status: 'absent',
      expiresAt: null,
      secondsRemaining: null,
    };
  }

  // Only Ed25519 JWTs are honored; anything else (legacy RVUI.*, garbage)
  // is invalid — mirrors checkLicense()'s acceptance gate.
  if (!key.startsWith('eyJ')) {
    return {
      tier: 'free',
      valid: false,
      present: true,
      source,
      status: 'invalid',
      expiresAt: null,
      secondsRemaining: null,
      reason: 'unrecognized license format (expected Ed25519 JWT)',
    };
  }

  const result = verifyLicenseJWT(key, getVendorPublicKey());

  if (result.valid) {
    const expiresAt = result.expiresAt > 0 ? result.expiresAt : null;
    if (expiresAt === null) {
      return {
        tier: result.tier,
        valid: true,
        present: true,
        source,
        status: 'perpetual',
        expiresAt: null,
        secondsRemaining: null,
      };
    }
    const secondsRemaining = expiresAt - nowSeconds;
    let status: LicenseStatus = 'ok';
    if (secondsRemaining <= DAY_SECONDS) status = 'expiring-1d';
    else if (secondsRemaining <= 7 * DAY_SECONDS) status = 'expiring-7d';
    else if (secondsRemaining <= 14 * DAY_SECONDS) status = 'expiring-14d';
    return {
      tier: result.tier,
      valid: true,
      present: true,
      source,
      status,
      expiresAt,
      secondsRemaining,
    };
  }

  // Failure. Distinguish expired (fail-closed) from other invalidity (degrade).
  if (result.code === 'expired') {
    const expiresAt = result.expiresAt ?? null;
    return {
      tier: 'free',
      valid: false,
      present: true,
      source,
      status: 'expired',
      expiresAt,
      secondsRemaining: expiresAt === null ? null : expiresAt - nowSeconds,
      reason: result.reason,
    };
  }

  return {
    tier: 'free',
    valid: false,
    present: true,
    source,
    status: 'invalid',
    expiresAt: null,
    secondsRemaining: null,
    reason: result.reason,
  };
}

/** Returns true if the given RPC method is exempt from license checks. */
export function isExemptMethod(method: string): boolean {
  return EXEMPT_METHODS.has(method);
}
