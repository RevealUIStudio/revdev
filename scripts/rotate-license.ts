#!/usr/bin/env -S node --import=tsx

/**
 * Rotate a RevDev license stored in revvault.
 *
 * Calendar rotation (default): mints a replacement when the current license
 * is within --threshold-days of expiry (default 14), so the new key is staged
 * BEFORE the daemon's fail-closed expiry fires. Idempotent — exits 0 with no
 * change when the license is still outside the window.
 *
 * Emergency rotation: --emergency --reason "<why>" rotates immediately
 * regardless of remaining time (laptop theft, vault anomaly, key exposure …).
 *
 * MANUAL TOOL (GAP-437 ruling, owner 2026-07-26): the weekly systemd timer
 * was retired — the founder license is perpetual-manual (calendar runs
 * no-op on a perpetual key: shouldRotate returns false for a null exp).
 * Run this on demand; --emergency deliberately mints an EXPIRING
 * replacement (default 90 days) so a leak response bounds the new key.
 *
 *   # calendar rotation of an expiring customer key (no-op outside 14d window)
 *   npx tsx scripts/rotate-license.ts \
 *     --vault-path forge/customers/acme/license-key --tier pro \
 *     --customer acme --days 90
 *
 *   # emergency rotation of the founder key (replaces perpetual with 90-day)
 *   npx tsx scripts/rotate-license.ts \
 *     --emergency --reason "laptop-theft 2026-05-24"
 *
 * Audit log: every rotation appends a row to $LICENSE_ROTATION_LOG (default
 * ~/.local/share/revealui/license-rotation-log.md). Operators who keep a
 * tracked rotation log point that env var at it.
 *
 * Optional alert: if $LICENSE_ROTATION_ALERT_WEBHOOK is set, a JSON summary is
 * POSTed there best-effort after a successful rotation.
 *
 * Reuses the exact mint path from issue-license.ts (issueLicense/revvaultSet).
 */

import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { revokeJti } from '../packages/daemon/src/revoked-jtis.js';
import {
  getPrivateKey,
  issueLicense,
  revvaultSet,
  validateLicenseStorePath,
} from './issue-license.js';

const DAY_SECONDS = 86_400;

interface RotateConfig {
  vaultPath: string;
  tier: 'pro' | 'max' | 'enterprise';
  customer?: string;
  days: number;
  /** Mint the replacement without an expiry — the return path to a perpetual
   * key after an emergency rotation. */
  perpetual: boolean;
  thresholdDays: number;
  emergency: boolean;
  reason?: string;
  auditLogPath: string;
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

/** Authenticate the stored token with the public half of the current signing
 * key before trusting its expiry or revocation identity. Expired tokens still
 * pass this signature check so they can be replaced on a calendar run. */
export function assertSignedPriorLicense(jwt: string, publicKey: string): void {
  try {
    const parts = jwt.trim().split('.');
    if (parts.length !== 3) throw new Error('invalid JWT shape');
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >;
    if (header.alg !== 'EdDSA') throw new Error('invalid algorithm');
    if (
      !verify(
        null,
        Buffer.from(`${headerB64}.${payloadB64}`),
        publicKey,
        Buffer.from(signatureB64, 'base64url'),
      )
    ) {
      throw new Error('invalid signature');
    }
  } catch {
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
  if (!Number.isInteger(cfg.days) || cfg.days < 1 || cfg.days > 36_500) {
    throw new Error('Replacement days must be an integer from 1 to 36500.');
  }
  if (!Number.isInteger(cfg.thresholdDays) || cfg.thresholdDays < 0 || cfg.thresholdDays > 36_500) {
    throw new Error('Threshold days must be an integer from 0 to 36500.');
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
    auditLogPath:
      process.env.LICENSE_ROTATION_LOG ??
      join(homedir(), '.local', 'share', 'revealui', 'license-rotation-log.md'),
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
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
  --vault-path <path>     revvault path of the license to rotate
                          (default: revealui/dev/founder-license-key)
  --tier <pro|max|enterprise>   tier for the replacement (default: enterprise)
  --customer <name>       customer id for the replacement (default: founder)
  --days <n>              expiry of the replacement, in days (default: 90)
  --perpetual             mint the replacement without an expiry — the return
                          path to a perpetual key after an emergency rotation
  --threshold-days <n>    rotate when within N days of expiry (default: 14)
  --emergency             rotate now regardless of remaining time
  --reason "<why>"        required with --emergency; recorded in the audit log
  --help, -h              show this help

Env:
  LICENSE_ROTATION_LOG            audit-log path (default: ~/.local/share/revealui/license-rotation-log.md)
  LICENSE_ROTATION_ALERT_WEBHOOK  optional URL to POST a JSON rotation summary to
`);
        process.exit(0);
    }
  }

  return cfg;
}

function readCurrentLicense(vaultPath: string): string {
  try {
    // `get --full`: plain `get` returns a masked preview, not the value
    // (same defect class as issue-license getPrivateKey, fixed 2026-07-26).
    return execFileSync('revvault', ['get', '--full', vaultPath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function appendAuditLog(
  auditLogPath: string,
  row: {
    timestamp: string;
    trigger: 'calendar' | 'emergency';
    reason: string;
    tier: string;
    customer: string;
    priorJti: string;
    priorExp: string;
    newExp: string;
    kid: string;
  },
): void {
  mkdirSync(dirname(auditLogPath), { recursive: true });
  const line =
    `| ${row.timestamp} | ${row.trigger} | ${row.reason} | ${row.tier} | ${row.customer} ` +
    `| ${row.priorJti} | ${row.priorExp} | ${row.newExp} | ${row.kid} |\n`;
  appendFileSync(auditLogPath, line);
}

async function postAlert(payload: Record<string, unknown>): Promise<void> {
  const url = process.env.LICENSE_ROTATION_ALERT_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[rotate] alert webhook failed (non-fatal): ${String(err)}`);
  }
}

function isoOrPerpetual(exp: number | null): string {
  return exp === null ? 'perpetual' : new Date(exp * 1000).toISOString();
}

async function main(): Promise<void> {
  const cfg = parseArgs();

  try {
    validateRotateConfig(cfg);
  } catch (err) {
    console.error(`[rotate] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (cfg.emergency && !cfg.reason) {
    console.error('[rotate] --emergency requires --reason "<why>"');
    process.exit(1);
  }

  const current = readCurrentLicense(cfg.vaultPath);
  if (!current) {
    console.error(
      `[rotate] no current license found at revvault path "${cfg.vaultPath}" ` +
        '(is revvault unlocked + the path correct?)',
    );
    process.exit(1);
  }

  const prior = decodeLicense(current);
  try {
    assertSignedPriorLicense(
      current,
      createPublicKey(getPrivateKey()).export({ type: 'spki', format: 'pem' }).toString(),
    );
    assertEmergencyRevocable(prior, cfg.emergency);
  } catch (err) {
    console.error(`[rotate] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (prior.malformed && !cfg.emergency) {
    console.error(
      `[rotate] current license at "${cfg.vaultPath}" is not a parseable JWT — refusing to ` +
        'silently skip rotation. Investigate the vault entry and use signing-key ' +
        'rotation or an explicit recovery path; this token cannot be revoked by jti.',
    );
    process.exit(1);
  }
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (!shouldRotate(prior.exp, nowSeconds, cfg.thresholdDays, cfg.emergency)) {
    console.log(
      `[rotate] no rotation needed — ${cfg.vaultPath} expires ${isoOrPerpetual(prior.exp)} ` +
        `(> ${cfg.thresholdDays}d away).`,
    );
    process.exit(0);
  }

  const newJwt = issueLicense({
    tier: cfg.tier,
    customer: cfg.customer,
    days: cfg.perpetual ? undefined : cfg.days,
    perpetual: cfg.perpetual,
  });
  revvaultSet(cfg.vaultPath, newJwt);
  if (prior.jti) {
    revokeJti(prior.jti);
  }
  const next = decodeLicense(newJwt);

  const timestamp = new Date().toISOString();
  const trigger: 'calendar' | 'emergency' = cfg.emergency ? 'emergency' : 'calendar';
  appendAuditLog(cfg.auditLogPath, {
    timestamp,
    trigger,
    reason: cfg.reason ?? (trigger === 'calendar' ? 'within-threshold' : '(unspecified)'),
    tier: cfg.tier,
    customer: cfg.customer ?? '(none)',
    priorJti: prior.jti ?? 'n/a',
    priorExp: isoOrPerpetual(prior.exp),
    newExp: isoOrPerpetual(next.exp),
    // No `kid` claim is minted yet (single signing key); recorded as n/a so the
    // column is ready when multi-key rotation lands.
    kid: 'n/a (single-key)',
  });

  console.log('');
  console.log('  License ROTATED');
  console.log('  ───────────────');
  console.log(`  Vault path: ${cfg.vaultPath}`);
  console.log(`  Trigger:    ${trigger}${cfg.reason ? ` (${cfg.reason})` : ''}`);
  console.log(`  Tier:       ${cfg.tier}   Customer: ${cfg.customer ?? '(none)'}`);
  console.log(`  Prior exp:  ${isoOrPerpetual(prior.exp)}`);
  console.log(`  New exp:    ${isoOrPerpetual(next.exp)}`);
  console.log(`  Audit log:  ${cfg.auditLogPath}`);
  console.log('');
  if (prior.jti) {
    console.log(
      `  Prior jti written to ${process.env.REVEALUI_REVOKED_JTI_FILE ?? '~/.local/share/revealui/revoked-jtis.json'}`,
    );
  }
  console.log('  ACTION: restart any daemon/Studio consuming this license so it');
  console.log('  reloads the rotated key (the new key is already in revvault).');
  console.log('');

  await postAlert({
    event: 'license.rotated',
    timestamp,
    trigger,
    reason: cfg.reason ?? null,
    vaultPath: cfg.vaultPath,
    tier: cfg.tier,
    customer: cfg.customer ?? null,
    priorExp: isoOrPerpetual(prior.exp),
    newExp: isoOrPerpetual(next.exp),
  });

  process.exit(0);
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
