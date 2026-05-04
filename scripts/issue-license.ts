#!/usr/bin/env -S node --import=tsx

/**
 * Issue a RevDev license key (Ed25519-signed JWT), or generate the
 * Ed25519 keypair the daemon uses to verify those keys.
 *
 * Usage:
 *   # First-time setup — mint vendor keypair, auto-store in revvault.
 *   npx tsx scripts/issue-license.ts --generate-keypair
 *
 *   # Issue customer licenses.
 *   npx tsx scripts/issue-license.ts --tier pro --customer "acme-corp"
 *   npx tsx scripts/issue-license.ts --tier enterprise --perpetual
 *   npx tsx scripts/issue-license.ts --tier max --days 365
 *
 * Signing private key is read from revvault at revdev/license-signing-private-key
 * (or REVDEV_LICENSE_PRIVATE_KEY env, or ~/.revealui/license-private.pem).
 *
 * Output: Ed25519-signed JWT (RFC 7519). Header: { alg: "EdDSA", typ: "JWT" }.
 * Payload: { tier, iat, iss, aud, customerId?, exp? }.
 * Format matches the RevealUI license API issuer (revealui#735, Phase A).
 */

import { execSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

interface Options {
  tier: 'pro' | 'max' | 'enterprise';
  customer?: string;
  days?: number;
  perpetual?: boolean;
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
  --help                        Show this help

Output format: Ed25519-signed JWT (RFC 7519). Set as REVEALUI_LICENSE_KEY on the daemon.
`);
        process.exit(0);
    }
  }

  return opts;
}

function getPrivateKey(): string {
  // 1. Environment variable
  if (process.env.REVDEV_LICENSE_PRIVATE_KEY) {
    return process.env.REVDEV_LICENSE_PRIVATE_KEY;
  }

  // 2. Revvault
  try {
    const key = execSync('revvault get revdev/license-signing-private-key', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (key) return key;
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

function issueLicense(opts: Options): string {
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
    payload['customerId'] = opts.customer;
  }

  if (!opts.perpetual) {
    payload['exp'] = now + (opts.days ?? 365) * 86400;
  }

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${headerB64}.${payloadB64}`;
  const signature = sign(null, Buffer.from(message), privateKey).toString('base64url');

  return `${message}.${signature}`;
}

function revvaultSet(path: string, value: string): void {
  try {
    execSync(`revvault set --force ${path}`, {
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

// --- Main ---
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
console.log('  Key:');
console.log(`  ${key}`);
console.log('');
console.log('  Deliver this key to the customer. They set it as:');
console.log('  REVEALUI_LICENSE_KEY=<key>');
console.log('');
