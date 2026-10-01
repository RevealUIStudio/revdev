import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revokeJti } from '../license-crypto.js';
import { runLicenseVerifyCommand } from '../license-verify-cli.js';
import {
  generateTestLicense,
  installTestLicenseAuthority,
  setTestLicenseEnv,
} from './test-license-helper.js';

afterEach(() => {
  delete process.env.REVEALUI_LICENSE_KEY;
  vi.restoreAllMocks();
});

describe('runLicenseVerifyCommand', () => {
  it('returns registered authorization for a hosted-verified JWT', async () => {
    const kit = generateTestLicense('pro');
    setTestLicenseEnv(kit);
    installTestLicenseAuthority();
    const { stdout, exitCode } = await runLicenseVerifyCommand(kit.licenseKey);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as {
      valid: boolean;
      tier: string;
      authorization: string;
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.tier).toBe('pro');
    expect(parsed.authorization).toBe('registered');
  });

  it('returns exit 1 for an invalid JWT without throwing', async () => {
    const kit = generateTestLicense('pro');
    setTestLicenseEnv(kit);
    installTestLicenseAuthority();
    const { stdout, exitCode } = await runLicenseVerifyCommand('not-a-jwt');
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout) as { valid: boolean; code?: string };
    expect(parsed.valid).toBe(false);
    expect(parsed.code).toBe('invalid-format');
  });

  it('rechecks local revocation after the hosted registration request', async () => {
    const kit = generateTestLicense('pro', true, { jti: 'cli-revoked-during-registration' });
    setTestLicenseEnv(kit);
    installTestLicenseAuthority();
    const fixtureFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith('/api/license/verify')) {
        revokeJti('cli-revoked-during-registration');
      }
      return fixtureFetch(input, init);
    });
    const { stdout, exitCode } = await runLicenseVerifyCommand(kit.licenseKey);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ valid: false, code: 'revoked' });
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
