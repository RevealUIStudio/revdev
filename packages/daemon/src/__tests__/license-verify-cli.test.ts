import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLicenseVerifyCommand } from '../license-verify-cli.js';

function makeToken(payload: Record<string, unknown>, privateKey: string): string {
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${headerB64}.${payloadB64}`;
  const signatureB64 = sign(null, Buffer.from(message, 'utf-8'), privateKey).toString('base64url');
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const NOW_S = Math.floor(Date.now() / 1000);

beforeEach(() => {
  process.env.REVDEV_LICENSE_PUBLIC_KEY = publicKey;
});

afterEach(() => {
  delete process.env.REVDEV_LICENSE_PUBLIC_KEY;
  vi.restoreAllMocks();
});

describe('runLicenseVerifyCommand', () => {
  it('returns valid JSON and exit 0 for a good JWT', () => {
    const token = makeToken(
      {
        tier: 'pro',
        iss: 'https://revealui.com',
        aud: 'revealui-license',
        jti: 'verify-cli',
        nbf: NOW_S - 10,
        iat: NOW_S - 10,
        exp: NOW_S + 3600,
      },
      privateKey,
    );
    const { stdout, exitCode } = runLicenseVerifyCommand(token);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { valid: boolean; tier: string };
    expect(parsed.valid).toBe(true);
    expect(parsed.tier).toBe('pro');
  });

  it('returns exit 1 for expired / invalid JWT without throwing', () => {
    const { stdout, exitCode } = runLicenseVerifyCommand('not-a-jwt');
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout) as { valid: boolean; code?: string };
    expect(parsed.valid).toBe(false);
    expect(parsed.code).toBe('invalid-format');
  });
});

describe('cli.ts license-verify early-exit band', () => {
  it('exits before startDaemon in source order', () => {
    const cli = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../cli.ts'), 'utf8');
    const verifyIdx = cli.indexOf("args[0] === 'license-verify'");
    const startIdx = cli.lastIndexOf('startDaemon(');
    expect(verifyIdx).toBeGreaterThan(0);
    expect(startIdx).toBeGreaterThan(verifyIdx);
    expect(cli.indexOf('process.exit(exitCode)', verifyIdx)).toBeGreaterThan(verifyIdx);
    expect(cli.indexOf('process.exit(exitCode)', verifyIdx)).toBeLessThan(startIdx);
  });
});
