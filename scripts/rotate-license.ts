#!/usr/bin/env -S node --import=tsx

/**
 * Authenticated hosted credential containment and replacement.
 * --operation-id is a stable UUID for persisted recovery. Explicit --perpetual
 * remains available. Vault promotion requires the maintained expected-current
 * primitive; committed hosted receipts recover before reading Vault.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchLicenseTrustSet } from '../packages/daemon/src/license-authority.js';
import { verifyLicenseJWTForPriorRotation } from '../packages/daemon/src/license-crypto.js';
import {
  promoteLicense,
  readCurrentLicense,
  requireOperationId,
  validateLicenseStorePath,
} from './issue-license.js';

const DAY_SECONDS = 86_400;

export interface RotateConfig {
  vaultPath: string;
  operationId?: string;
  expectedMode?: 'live' | 'test';
  tier: 'pro' | 'max' | 'enterprise';
  customer?: string;
  days: number;
  /** Mint the replacement without an expiry — the return path to a perpetual
   * key after an emergency rotation. */
  perpetual: boolean;
  thresholdDays: number;
  emergency: boolean;
  reason?: string;
}

/** Subset of license claims needed for the rotation decision + audit row. */
export interface DecodedLicense {
  exp: number | null; // unix seconds; null = perpetual / absent
  customerId: string | null;
  jti: string | null;
  tier: string | null;
  /** True when the token could not be parsed (corrupt/truncated) — distinct
   *  from a valid perpetual license (exp null, malformed false). */
  malformed: boolean;
}

/**
 * Decode (NOT verify) a license JWT to read its claims. The rotation CLI
 * verifies the stored token's signature before using these decoded claims.
 */
export function decodeLicense(jwt: string): DecodedLicense {
  const parts = jwt.trim().split('.');
  if (parts.length !== 3) {
    return { exp: null, customerId: null, jti: null, tier: null, malformed: true };
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1] as string, 'base64url').toString('utf-8'),
    ) as Record<string, unknown>;
    return {
      exp: typeof payload.exp === 'number' ? payload.exp : null,
      customerId: typeof payload.customerId === 'string' ? payload.customerId : null,
      jti: typeof payload.jti === 'string' ? payload.jti : null,
      tier: typeof payload.tier === 'string' ? payload.tier : null,
      malformed: false,
    };
  } catch {
    return { exp: null, customerId: null, jti: null, tier: null, malformed: true };
  }
}

/** Validate the prior token through the shared verifier, allowing only expiry. */
export function assertSignedPriorLicense(
  jwt: string,
  publicKeys: string | readonly (string | { publicKey: string; keyId: string })[],
): void {
  const candidates = typeof publicKeys === 'string' ? [publicKeys] : publicKeys;
  const result = verifyLicenseJWTForPriorRotation(jwt, candidates);
  if (!result.valid) {
    throw new Error('Current license signature cannot be verified; refusing rotation.');
  }
}

/**
 * Rotation decision. Emergency always rotates. Otherwise rotate only when a
 * dated license is within the threshold window; a perpetual license (exp null)
 * never calendar-rotates.
 */
export function shouldRotate(
  exp: number | null,
  nowSeconds: number,
  thresholdDays: number,
  emergency: boolean,
): boolean {
  if (emergency) return true;
  if (exp === null) return false;
  return exp - nowSeconds <= thresholdDays * DAY_SECONDS;
}

export function assertEmergencyRevocable(prior: DecodedLicense, emergency: boolean): void {
  if (emergency && (prior.malformed || !prior.jti?.trim())) {
    throw new Error(
      'Current license has no revocable jti. Emergency replacement would leave the old key valid; rotate the signing key or add legacy-token revocation first.',
    );
  }
}

export function validateRotateConfig(cfg: RotateConfig): void {
  validateLicenseStorePath(cfg.vaultPath);
  if (!['pro', 'max', 'enterprise'].includes(cfg.tier)) {
    throw new Error('Replacement tier must be pro, max, or enterprise.');
  }
  if (!Number.isInteger(cfg.days) || cfg.days < 1 || cfg.days > 3650) {
    throw new Error('Replacement days must be an integer from 1 to 3650.');
  }
  if (!Number.isInteger(cfg.thresholdDays) || cfg.thresholdDays < 0 || cfg.thresholdDays > 36_500) {
    throw new Error('Threshold days must be an integer from 0 to 36500.');
  }
  requireOperationId(cfg.operationId);
  if (cfg.expectedMode !== 'live' && cfg.expectedMode !== 'test') {
    throw new Error('Vault promotion requires an explicit --mode live or test.');
  }
}

function parseArgs(): RotateConfig {
  const args = process.argv.slice(2);
  const cfg: RotateConfig = {
    // Real founder path (the old default revdev/licenses/founder-jwt never
    // existed — the argless timer exited 1 on every run before retirement).
    // Safe target: calendar runs no-op on the perpetual key; only an
    // explicit --emergency replaces it (with a bounded 90-day key).
    vaultPath: 'revealui/dev/founder-license-key',
    tier: 'enterprise',
    customer: 'founder',
    days: 90,
    perpetual: false,
    thresholdDays: 14,
    emergency: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--operation-id':
        cfg.operationId = args[++i];
        break;
      case '--mode':
        cfg.expectedMode = args[++i] as RotateConfig['expectedMode'];
        break;
      case '--vault-path':
        cfg.vaultPath = args[++i] ?? cfg.vaultPath;
        break;
      case '--tier':
        cfg.tier = args[++i] as RotateConfig['tier'];
        break;
      case '--customer':
        cfg.customer = args[++i];
        break;
      case '--days':
        cfg.days = Number(args[++i]);
        break;
      case '--threshold-days':
        cfg.thresholdDays = Number(args[++i]);
        break;
      case '--perpetual':
        cfg.perpetual = true;
        break;
      case '--emergency':
        cfg.emergency = true;
        break;
      case '--reason':
        cfg.reason = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
Rotate a RevDev license stored in revvault.

Usage:
  npx tsx scripts/rotate-license.ts [options]

Options:
  --operation-id <uuid>       Stable hosted operation identifier
  --mode <live|test>          Required expected hosted mode (no default)
  --vault-path <path>     revvault path of the license to rotate
                          (default: revealui/dev/founder-license-key)
  --tier <pro|max|enterprise>   tier for the replacement (default: enterprise)
  --customer <name>       customer id for the replacement (default: founder)
  --days <n>              expiry of the replacement, in days (default: 90)
  --perpetual             mint the replacement without an expiry — the return
                          path to a perpetual key after an emergency rotation
  --threshold-days <n>    rotate when within N days of expiry (default: 14)
  --emergency             rotate now regardless of remaining time
  --reason "<why>"        required with --emergency; no credential values logged
  --help, -h              show this help

Env:
Hosted containment uses existing REVEALUI_ADMIN_API_KEY authentication.
Credential promotion requires matching issuer trust and the maintained conditional RevVault CLI.
A stable operation UUID recovers a committed hosted result across signer outages.
`);
        process.exit(0);
        break;
      default:
        throw new Error('Unknown license rotation option.');
    }
  }

  return cfg;
}

/** Existing rotation flow recovers a committed operation before examining today's prior. */
export async function rotateLicense(
  cfg: RotateConfig,
): Promise<{ status: 'not-needed' } | { status: 'promoted'; operationId: string; path: string }> {
  validateRotateConfig(cfg);
  const trustSet = await fetchLicenseTrustSet();
  if (!trustSet) throw new Error('Hosted issuer trust unavailable; refusing license rotation.');
  if (cfg.emergency && !cfg.reason?.trim()) {
    throw new Error('--emergency requires a reason.');
  }
  return promoteLicense(
    {
      operationId: cfg.operationId,
      expectedMode: cfg.expectedMode,
      tier: cfg.tier,
      customer: cfg.customer,
      days: cfg.perpetual ? undefined : cfg.days,
      perpetual: cfg.perpetual,
    },
    { kind: 'rotation', path: cfg.vaultPath },
    () => {
      const stored = readCurrentLicense(cfg.vaultPath);
      const prior = decodeLicense(stored.token);
      assertSignedPriorLicense(stored.token, trustSet.keys);
      assertEmergencyRevocable(prior, cfg.emergency);
      if (prior.malformed) throw new Error('Current license is malformed; refusing rotation.');
      if (
        !shouldRotate(prior.exp, Math.floor(Date.now() / 1000), cfg.thresholdDays, cfg.emergency)
      ) {
        return null;
      }
      if (
        prior.customerId !== cfg.customer ||
        !prior.jti?.trim() ||
        prior.jti !== prior.jti.trim()
      ) {
        throw new Error('Current license lacks matching customer or revocable identity.');
      }
      return {
        expectedCurrentLicenseKey: stored.token,
        expected: { kind: 'sha256', sha256: stored.sha256 },
      };
    },
  );
}

async function main(): Promise<void> {
  try {
    const outcome = await rotateLicense(parseArgs());
    console.log(
      `[rotate] ${outcome.status === 'promoted' ? 'Local license promotion committed.' : 'No calendar rotation needed.'}`,
    );
  } catch (error) {
    console.error(
      `[rotate] ${error instanceof Error ? error.message : 'License rotation failed.'}`,
    );
    process.exitCode = 1;
  }
}

/** True when this file is the process entrypoint (not imported). */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
