#!/usr/bin/env -S node --import=tsx

/**
 * Issue a RevDev license key (Ed25519-signed v2 format).
 *
 * Usage:
 *   npx tsx scripts/issue-license.ts --tier pro --customer "acme-corp"
 *   npx tsx scripts/issue-license.ts --tier enterprise --perpetual
 *   npx tsx scripts/issue-license.ts --tier max --days 365
 *
 * Reads the signing private key from revvault or REVDEV_LICENSE_PRIVATE_KEY env.
 */

import { execSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
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
Issue RevDev License Key (Ed25519 v2)

Usage:
  npx tsx scripts/issue-license.ts [options]

Options:
  --tier <pro|max|enterprise>   License tier (required)
  --customer <name>             Customer identifier
  --days <n>                    Expiry in days (default: 365)
  --perpetual                   Never expires
  --help                        Show this help
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

  const expiresAt = opts.perpetual
    ? '0'
    : String(Math.floor(Date.now() / 1000) + (opts.days ?? 365) * 86400);

  const message = `${opts.tier}.${expiresAt}`;
  const signature = sign(null, Buffer.from(message), privateKey).toString('base64url');

  return `RVUI.v2.${opts.tier}.${expiresAt}.${signature}`;
}

// --- Main ---
const opts = parseArgs();
const key = issueLicense(opts);

console.log('');
console.log('  License Key Issued');
console.log('  ──────────────────');
console.log(`  Tier:     ${opts.tier.toUpperCase()}`);
console.log(`  Customer: ${opts.customer ?? '(not specified)'}`);
console.log(`  Expires:  ${opts.perpetual ? 'Never (perpetual)' : `${opts.days ?? 365} days`}`);
console.log('');
console.log('  Key:');
console.log(`  ${key}`);
console.log('');
console.log('  Deliver this key to the customer. They set it as:');
console.log('  REVEALUI_LICENSE_KEY=<key>');
console.log('');
