#!/usr/bin/env tsx

/**
 * Generate an Ed25519-signed RevDev license key.
 *
 * Usage:
 *   pnpm exec tsx scripts/generate-license-key.ts --tier pro --days 365
 *   pnpm exec tsx scripts/generate-license-key.ts --tier enterprise --perpetual
 *
 * The signing private key is read from revvault at `revdev/license-signing-key`.
 * To generate a new keypair:
 *   pnpm exec tsx scripts/generate-license-key.ts --generate-keypair
 */

import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';

const REVVAULT_BIN =
  process.env.REVVAULT ?? `${process.env.HOME}/suite/revvault/target/release/revvault`;

function revvault(path: string): string | null {
  const result = spawnSync(REVVAULT_BIN, ['get', '--full', path], {
    encoding: 'utf8',
  });
  if (result.status === 0) {
    const value = result.stdout.trimEnd();
    if (value.length > 0) return value;
  }
  return null;
}

function revvaultSet(path: string, value: string): void {
  const result = spawnSync(REVVAULT_BIN, ['set', '--force', path], {
    input: value,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(`Failed to store ${path} in revvault:`, result.stderr);
    process.exit(1);
  }
}

// --- Generate keypair mode ---
if (process.argv.includes('--generate-keypair')) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  console.log('Generated Ed25519 keypair.\n');
  console.log('=== PUBLIC KEY (embed in daemon / set as REVDEV_LICENSE_PUBLIC_KEY) ===');
  console.log(publicKey);
  console.log('=== PRIVATE KEY (stored in revvault) ===');
  console.log('[stored at revdev/license-signing-key]');

  revvaultSet('revdev/license-signing-key', privateKey as string);
  revvaultSet('revdev/license-public-key', publicKey as string);

  console.log('\nDone. Keys stored in revvault:');
  console.log('  revdev/license-signing-key (private)');
  console.log('  revdev/license-public-key (public)');
  console.log('\nSet REVDEV_LICENSE_PUBLIC_KEY in daemon env to the public key above.');
  process.exit(0);
}

// --- Sign a license key ---
const args = process.argv.slice(2);
const tierIdx = args.indexOf('--tier');
const daysIdx = args.indexOf('--days');
const perpetual = args.includes('--perpetual');

if (tierIdx === -1) {
  console.error(
    'Usage: tsx scripts/generate-license-key.ts --tier <pro|max|enterprise> [--days N | --perpetual]',
  );
  process.exit(1);
}

const tier = args[tierIdx + 1];
if (!tier || !['pro', 'max', 'enterprise'].includes(tier)) {
  console.error('Tier must be one of: pro, max, enterprise');
  process.exit(1);
}

let expiresAt = 0; // perpetual by default
if (!perpetual && daysIdx !== -1) {
  const days = parseInt(args[daysIdx + 1] ?? '', 10);
  if (Number.isNaN(days) || days <= 0) {
    console.error('--days must be a positive integer');
    process.exit(1);
  }
  expiresAt = Math.floor(Date.now() / 1000) + days * 86400;
} else if (!perpetual) {
  // Default: 365 days
  expiresAt = Math.floor(Date.now() / 1000) + 365 * 86400;
}

const privateKeyPem = revvault('revdev/license-signing-key');
if (!privateKeyPem) {
  console.error(
    'Private key not found in revvault at revdev/license-signing-key.\n' +
      'Generate a keypair first: tsx scripts/generate-license-key.ts --generate-keypair',
  );
  process.exit(1);
}

const message = `${tier}.${expiresAt}`;
const signature = sign(null, Buffer.from(message), privateKeyPem);
const signatureB64 = signature.toString('base64url');

const licenseKey = `RVUI.v2.${tier}.${expiresAt}.${signatureB64}`;

console.log('=== License Key ===');
console.log(licenseKey);
console.log('');
console.log(`Tier: ${tier}`);
console.log(
  `Expires: ${expiresAt === 0 ? 'never (perpetual)' : new Date(expiresAt * 1000).toISOString()}`,
);
console.log('');
console.log(`Set in env: REVEALUI_LICENSE_KEY=${licenseKey}`);
