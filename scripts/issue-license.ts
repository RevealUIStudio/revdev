#!/usr/bin/env -S node --import=tsx

/** Authenticated hosted issuance. Local signing keys cannot establish shared revocation authority. */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LICENSE_API_ORIGIN } from '../packages/daemon/src/license-authority.js';
import { getVendorPublicKey, verifyLicenseJWT } from '../packages/daemon/src/license-crypto.js';

export interface Options {
  tier: 'pro' | 'max' | 'enterprise';
  operationId?: string;
  expectedCurrentLicenseKey?: string;
  customer?: string;
  days?: number;
  perpetual?: boolean;
  /** Explicit revvault destination; overrides the derived default. */
  store?: string;
  /** Print the JWT to stdout instead of storing (delivery flows). */
  print?: boolean;
}

/**
 * Default revvault destination for a minted license. The founder dogfood key
 * has a fixed fleet path; customer keys follow the forge/customers/* pattern
 * already in the vault. No customer and no --store → no silent default.
 */
export function deriveStorePath(opts: Options): string | null {
  if (opts.store) return opts.store;
  if (opts.customer === 'founder') return 'revealui/dev/founder-license-key';
  if (opts.customer) return `forge/customers/${opts.customer}/license-key`;
  return null;
}

/** License writes may only target the two supported license-key namespaces.
 * In particular, a CLI --store value must never reach a signing-key path. */
export function validateLicenseStorePath(path: string): void {
  if (
    path !== 'revealui/dev/founder-license-key' &&
    !/^forge\/customers\/[a-zA-Z0-9][a-zA-Z0-9._-]*\/license-key$/.test(path)
  ) {
    throw new Error('Vault destination must be a supported license-key path.');
  }
}

export function validateIssueOptions(opts: Options): void {
  if (!['pro', 'max', 'enterprise'].includes(opts.tier)) {
    throw new Error('License tier must be pro, max, or enterprise.');
  }
  if (
    opts.days !== undefined &&
    (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 3650)
  ) {
    throw new Error('License days must be an integer from 1 to 3650.');
  }
  if (opts.perpetual && opts.days !== undefined) {
    throw new Error('Use either --perpetual or --days, not both.');
  }
  if (opts.customer !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(opts.customer)) {
    throw new Error('Customer must be a single path-safe identifier.');
  }
  const storePath = deriveStorePath(opts);
  if (storePath !== null) validateLicenseStorePath(storePath);
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = { tier: 'pro' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--operation-id':
        opts.operationId = args[++i];
        break;
      case '--tier':
        opts.tier = args[++i] as Options['tier'];
        break;
      case '--customer':
        opts.customer = args[++i];
        break;
      case '--days':
        opts.days = Number(args[++i]);
        break;
      case '--perpetual':
        opts.perpetual = true;
        break;
      case '--store':
        opts.store = args[++i];
        break;
      case '--print':
        opts.print = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Issue registered RevDev license through hosted authority

Usage:
  npx tsx scripts/issue-license.ts --tier <pro|max|enterprise> [options]

Options:
  --operation-id <uuid>         Stable identifier retained across retries.
  --tier <pro|max|enterprise>   License tier (authenticated hosted grant)
  --customer <name>             Customer identifier (embedded in JWT payload)
  --days <n>                    Expiry in days (default: 90)
  --perpetual                   Never expires (omits exp claim)
  --store <revvault-path>       Vault destination (default derived: founder →
                                revealui/dev/founder-license-key, else
                                forge/customers/<customer>/license-key)
  --print                       Print the JWT to stdout instead of storing
  --help                        Show this help

Hosted issuance uses existing REVEALUI_ADMIN_API_KEY authentication.
Store promotion is unavailable until RevVault supports expected-current credential writes.
--print explicitly delivers the registered token; it does not activate a machine.
`);
        process.exit(0);
    }
  }

  return opts;
}

export function requireOperationId(value: string | undefined): string {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error('Hosted issuance requires a stable operation UUID.');
  }
  return value;
}

export async function issueLicense(opts: Options): Promise<string> {
  validateIssueOptions(opts);
  const operationId = requireOperationId(opts.operationId);
  if (!opts.customer) throw new Error('Hosted issuance requires customer identity.');
  const adminKey = process.env.REVEALUI_ADMIN_API_KEY;
  if (!adminKey?.trim()) throw new Error('Hosted operator admin authentication is not configured.');
  let response: Response;
  try {
    response = await fetch(`${LICENSE_API_ORIGIN}/api/license/generate`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', 'X-Admin-API-Key': adminKey },
      body: JSON.stringify({
        operationId,
        tier: opts.tier,
        customerId: opts.customer,
        perpetual: opts.perpetual === true,
        expiresInDays: opts.days,
        expectedCurrentLicenseKey: opts.expectedCurrentLicenseKey,
      }),
    });
    if (!response.ok || response.redirected) throw new Error('denied');
  } catch {
    throw new Error('Hosted license operation unavailable or migration required.');
  }
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error('Hosted license operation returned invalid identity.');
  }
  if (
    typeof body.licenseKey !== 'string' ||
    body.tier !== opts.tier ||
    body.customerId !== opts.customer
  ) {
    throw new Error('Hosted license operation returned invalid identity.');
  }
  const verified = verifyLicenseJWT(body.licenseKey, getVendorPublicKey());
  if (!verified.valid || verified.tier !== opts.tier) {
    throw new Error('Hosted issuer trust migration required; returned token rejected.');
  }
  const claims = JSON.parse(
    Buffer.from(body.licenseKey.split('.')[1] as string, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  if (
    claims.customerId !== opts.customer ||
    typeof claims.jti !== 'string' ||
    !claims.jti.trim() ||
    (opts.perpetual === true ? claims.exp !== undefined : typeof claims.exp !== 'number')
  ) {
    throw new Error('Hosted license operation returned invalid identity.');
  }
  return body.licenseKey;
}

/** Force overwrite cannot provide expected-current credential promotion. */
export function revvaultSet(path: string, _value: string): never {
  validateLicenseStorePath(path);
  throw new Error(
    'Credential promotion requires the maintained RevVault expected-current operation; force overwrite is refused.',
  );
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

// --- CLI ---
// Only runs when invoked directly; importing this module is side-effect-free
// so rotate-license.ts can reuse the authenticated issueLicense primitive.
if (isMainModule()) {
  // Help is side-effect-free; retired local key generation always refuses.
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    parseArgs(); // prints help and exits
  }

  if (process.argv.includes('--generate-keypair')) {
    throw new Error(
      'Local signing key generation retired; hosted issuer trust migration required.',
    );
  }

  const opts = parseArgs();
  if (!opts.print) {
    throw new Error(
      'Credential promotion requires the maintained RevVault expected-current operation.',
    );
  }
  let key: string;
  try {
    key = await issueLicense(opts);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log('');
  console.log('  License Key Issued');
  console.log('  ──────────────────');
  console.log(`  Tier:     ${opts.tier.toUpperCase()}`);
  console.log(`  Customer: ${opts.customer ?? '(not specified)'}`);
  console.log(`  Expires:  ${opts.perpetual ? 'Never (perpetual)' : `${opts.days ?? 90} days`}`);
  console.log(`  Format:   Ed25519-signed JWT (RFC 7519)`);
  console.log('');

  if (opts.print) {
    console.log('  Key:');
    console.log(`  ${key}`);
    console.log('');
    console.log('  Deliver this key to the customer. They set it as:');
    console.log('  REVEALUI_LICENSE_KEY=<key>');
    console.log('');
  }
}
