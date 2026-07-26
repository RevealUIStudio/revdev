#!/usr/bin/env -S node --import=tsx

/**
 * Issue a RevDev license key (Ed25519-signed JWT), or generate the
 * Ed25519 keypair the daemon uses to verify those keys.
 *
 * Usage:
 *   # First-time setup — mint vendor keypair, auto-store in revvault.
 *   npx tsx scripts/issue-license.ts --generate-keypair
 *
 *   # Issue customer licenses. DEFAULT: mint-and-store straight into revvault
 *   # (owner directive 2026-07-26) — the key never touches disk, stdout, or a
 *   # clipboard. The vault path is derived from --customer (founder →
 *   # revealui/dev/founder-license-key, else forge/customers/<id>/license-key)
 *   # or given explicitly with --store <path>.
 *   npx tsx scripts/issue-license.ts --tier enterprise --customer founder --perpetual
 *   npx tsx scripts/issue-license.ts --tier pro --customer "acme-corp"
 *
 *   # Opt-out for delivery flows that need the value on stdout:
 *   npx tsx scripts/issue-license.ts --tier max --days 365 --customer acme --print
 *
 * Signing private key is read from revvault at revdev/license-signing-private-key
 * (or REVDEV_LICENSE_PRIVATE_KEY env, or ~/.revealui/license-private.pem).
 *
 * Output: Ed25519-signed JWT (RFC 7519). Header: { alg: "EdDSA", typ: "JWT" }.
 * Payload: { tier, iat, iss, aud, customerId?, exp? }.
 * Format matches the RevealUI license API issuer (revealui#735, Phase A).
 *
 * The signing helpers (issueLicense / getPrivateKey / revvaultSet) are
 * exported so sibling tooling (e.g. scripts/rotate-license.ts) can reuse the
 * exact mint path. The CLI body only runs when this file is the entrypoint
 * (import.meta main-guard), so importing it has no side effects.
 */

import { execFileSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Options {
  tier: 'pro' | 'max' | 'enterprise';
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

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = { tier: 'pro' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--tier':
        opts.tier = args[++i] as Options['tier'];
        break;
      case '--customer':
        opts.customer = args[++i];
        break;
      case '--days':
        opts.days = parseInt(args[++i], 10);
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
Issue RevDev License Key (Ed25519-signed JWT)

Usage:
  npx tsx scripts/issue-license.ts --generate-keypair
  npx tsx scripts/issue-license.ts --tier <pro|max|enterprise> [options]

Options:
  --generate-keypair            Mint vendor Ed25519 keypair and store in revvault
                                (revdev/license-signing-{private,public}-key).
                                Exits before signing.
  --tier <pro|max|enterprise>   License tier (required for signing)
  --customer <name>             Customer identifier (embedded in JWT payload)
  --days <n>                    Expiry in days (default: 365)
  --perpetual                   Never expires (omits exp claim)
  --store <revvault-path>       Vault destination (default derived: founder →
                                revealui/dev/founder-license-key, else
                                forge/customers/<customer>/license-key)
  --print                       Print the JWT to stdout instead of storing
  --help                        Show this help

Default behavior is mint-and-store: the signed JWT goes straight into revvault
via stdin (never disk, never stdout) and the stored value is verified by
readback. Use --print only when a delivery flow needs the raw value.
Format: Ed25519-signed JWT (RFC 7519). Set as REVEALUI_LICENSE_KEY on the daemon.
`);
        process.exit(0);
    }
  }

  return opts;
}

export function getPrivateKey(): string {
  // 1. Environment variable
  if (process.env.REVDEV_LICENSE_PRIVATE_KEY) {
    return process.env.REVDEV_LICENSE_PRIVATE_KEY;
  }

  // 2. Revvault — MUST be `get --full`: plain `get` returns a masked preview
  // (~28 bytes), which createPrivateKey rejects with ERR_OSSL_UNSUPPORTED
  // (hit live 2026-07-26).
  try {
    const key = execFileSync('revvault', ['get', '--full', 'revdev/license-signing-private-key'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (key.includes('-----BEGIN')) return key;
    if (key) {
      console.error(
        'Error: revvault returned a non-PEM value for revdev/license-signing-private-key (masked preview or corrupt entry).',
      );
      process.exit(1);
    }
  } catch {
    // revvault not available
  }

  // 3. Local file
  const localPath = `${process.env.HOME}/.revealui/license-private.pem`;
  try {
    return readFileSync(localPath, 'utf-8');
  } catch {
    // not found
  }

  console.error('Error: No signing key found.');
  console.error(
    'Set REVDEV_LICENSE_PRIVATE_KEY, or store in revvault at revdev/license-signing-private-key',
  );
  process.exit(1);
}

export function issueLicense(opts: Options): string {
  const privateKeyPem = getPrivateKey();
  const privateKey = createPrivateKey(privateKeyPem);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT' };
  const payload: Record<string, unknown> = {
    tier: opts.tier,
    iat: now,
    iss: 'https://revealui.com',
    aud: 'revealui-license',
  };

  if (opts.customer) {
    payload.customerId = opts.customer;
  }

  if (!opts.perpetual) {
    payload.exp = now + (opts.days ?? 365) * 86400;
  }

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${headerB64}.${payloadB64}`;
  const signature = sign(null, Buffer.from(message), privateKey).toString('base64url');

  return `${message}.${signature}`;
}

export function revvaultSet(path: string, value: string): void {
  try {
    execFileSync('revvault', ['set', '--force', path], {
      input: value,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error(`Failed to store ${path} in revvault.`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function generateKeypair(): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  revvaultSet('revdev/license-signing-private-key', privateKey as string);
  revvaultSet('revdev/license-signing-public-key', publicKey as string);

  console.log('');
  console.log('  Ed25519 Keypair Generated');
  console.log('  ─────────────────────────');
  console.log('  Stored in revvault:');
  console.log('    revdev/license-signing-private-key');
  console.log('    revdev/license-signing-public-key');
  console.log('');
  console.log('  Public key (set as REVDEV_LICENSE_PUBLIC_KEY in daemon env):');
  console.log('');
  console.log(publicKey);
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
// so rotate-license.ts can reuse issueLicense()/getPrivateKey()/revvaultSet().
if (isMainModule()) {
  // Honor --help before any state-changing action: --generate-keypair writes to
  // revvault, so a `--generate-keypair --help` call must NOT rotate keys.
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    parseArgs(); // prints help and exits
  }

  if (process.argv.includes('--generate-keypair')) {
    generateKeypair();
    process.exit(0);
  }

  const opts = parseArgs();
  const key = issueLicense(opts);

  console.log('');
  console.log('  License Key Issued');
  console.log('  ──────────────────');
  console.log(`  Tier:     ${opts.tier.toUpperCase()}`);
  console.log(`  Customer: ${opts.customer ?? '(not specified)'}`);
  console.log(`  Expires:  ${opts.perpetual ? 'Never (perpetual)' : `${opts.days ?? 365} days`}`);
  console.log(`  Format:   Ed25519-signed JWT (RFC 7519)`);
  console.log('');

  if (opts.print) {
    console.log('  Key:');
    console.log(`  ${key}`);
    console.log('');
    console.log('  Deliver this key to the customer. They set it as:');
    console.log('  REVEALUI_LICENSE_KEY=<key>');
    console.log('');
  } else {
    // Default: mint-and-store. The key goes to revvault via stdin — never
    // disk, never stdout, nothing to copy-paste (owner directive 2026-07-26).
    const storePath = deriveStorePath(opts);
    if (!storePath) {
      console.error(
        'Error: no vault destination. Pass --customer (path is derived) or --store <revvault-path>, or use --print for stdout delivery.',
      );
      process.exit(1);
    }
    revvaultSet(storePath, key);
    // Readback verification: stored value must be a 3-part JWT. Shape only —
    // the value is never displayed.
    let readback = '';
    try {
      readback = execFileSync('revvault', ['get', '--full', storePath], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // handled below
    }
    if (readback.split('.').length !== 3) {
      console.error(`Error: readback from ${storePath} is not a JWT — store may have failed.`);
      process.exit(1);
    }
    console.log(`  Stored:   ${storePath} (readback verified; value not displayed)`);
    console.log('');
    console.log('  Load it with:');
    console.log(`  export REVEALUI_LICENSE_KEY="$(revvault get --full ${storePath})"`);
    console.log('');
  }
}
