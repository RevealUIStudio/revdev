import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  guardRpcMethod,
  initLicenseGuard,
  refreshLicense,
  runtimeLicenseRecheck,
} from '../guard.js';
import { verifyLicenseJWT } from '../license-crypto.js';
import { isRevokedJti, RevocationStateError, revokeJti } from '../revoked-jtis.js';
import { generateTestLicense, setTestLicenseEnv } from './test-license-helper.js';

let dir: string;
let store: string;
const settings = [
  'REVEALUI_LICENSE_KEY',
  'REVEALUI_LICENSE_KEY_FILE',
  'REVDEV_LICENSE_PUBLIC_KEY',
  'REVEALUI_REVOKED_JTI_FILE',
  'REVDEV_DAEMON_DATA',
] as const;
let prior: Array<string | undefined>;
beforeEach(() => {
  prior = settings.map((key) => process.env[key]);
  dir = mkdtempSync(join(tmpdir(), 'revdev-local-revocation-'));
  store = join(dir, 'revoked.json');
  process.env.REVEALUI_REVOKED_JTI_FILE = store;
  process.env.REVDEV_DAEMON_DATA = dir;
  delete process.env.REVEALUI_LICENSE_KEY_FILE;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  settings.forEach((key, index) => {
    if (prior[index] === undefined) delete process.env[key];
    else process.env[key] = prior[index];
  });
  rmSync(dir, { recursive: true, force: true });
});

function activeLicense() {
  const kit = generateTestLicense('pro', true, { jti: 'synthetic-active-jti' });
  setTestLicenseEnv(kit);
  initLicenseGuard();
  expect(guardRpcMethod('agent.spawn').allowed).toBe(true);
  return kit;
}

describe('running guard local authorization', () => {
  it('denies the next paid dispatch after local revocation without restart or refresh', () => {
    activeLicense();
    revokeJti('synthetic-active-jti');
    expect(guardRpcMethod('agent.spawn').allowed).toBe(false);
    expect(guardRpcMethod('ping').allowed).toBe(true);
    expect(guardRpcMethod('session.end').allowed).toBe(true);
  });
  it('rechecks actual current token instead of retaining an earlier token authorization', () => {
    activeLicense();
    process.env.REVEALUI_LICENSE_KEY = 'invalid-replacement-token';
    expect(guardRpcMethod('agent.spawn').allowed).toBe(false);
    expect(guardRpcMethod('ping').allowed).toBe(true);
  });
  it('rechecks a configured token file replacement without restart', () => {
    const kit = activeLicense();
    delete process.env.REVEALUI_LICENSE_KEY;
    const path = join(dir, 'license.key');
    writeFileSync(path, kit.licenseKey);
    process.env.REVEALUI_LICENSE_KEY_FILE = path;
    expect(guardRpcMethod('agent.spawn').allowed).toBe(true);
    writeFileSync(path, 'invalid-token');
    expect(guardRpcMethod('agent.spawn').allowed).toBe(false);
  });
  it('denies paid dispatch when the configured token file is missing, preserving lifecycle', () => {
    activeLicense();
    delete process.env.REVEALUI_LICENSE_KEY;
    process.env.REVEALUI_LICENSE_KEY_FILE = join(dir, 'missing.key');
    expect(guardRpcMethod('agent.spawn').allowed).toBe(false);
    expect(guardRpcMethod('session.end').allowed).toBe(true);
  });
  it('downgrades a runtime recheck and each dispatch after authenticated expiry', () => {
    vi.useFakeTimers();
    try {
      const kit = generateTestLicense('pro', false, { daysUntilExpiry: 1, jti: 'expiring-jti' });
      setTestLicenseEnv(kit);
      initLicenseGuard();
      vi.setSystemTime(Date.now() + 2 * 86400 * 1000);
      expect(runtimeLicenseRecheck().valid).toBe(false);
      expect(guardRpcMethod('agent.spawn').allowed).toBe(false);
      expect(guardRpcMethod('session.end').allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('revocation store failure is never empty permission state', () => {
  for (const contents of [
    'not-json',
    'null',
    '{}',
    '{"jtis": "invalid"}',
    '{"jtis": ["revoked", 1]}',
    '{"jtis": [""]}',
    '{"jtis": [" synthetic-active-jti "]}',
  ]) {
    it(`fails closed for malformed store ${contents}`, () => {
      const kit = activeLicense();
      writeFileSync(store, contents);
      expect(() => isRevokedJti('synthetic-active-jti')).toThrow(RevocationStateError);
      expect(() => revokeJti('another')).toThrow(RevocationStateError);
      expect(readFileSync(store, 'utf8')).toBe(contents);
      expect(verifyLicenseJWT(kit.licenseKey, kit.publicKey)).toMatchObject({
        valid: false,
        code: 'revocation-unavailable',
      });
      expect(guardRpcMethod('agent.spawn').allowed).toBe(false);
      expect(guardRpcMethod('ping').allowed).toBe(true);
    });
  }
  it('denies authorization for a store path that cannot be read as a file', () => {
    const kit = activeLicense();
    mkdirSync(store);
    expect(verifyLicenseJWT(kit.licenseKey, kit.publicKey)).toMatchObject({
      valid: false,
      code: 'revocation-unavailable',
    });
    expect(guardRpcMethod('agent.spawn').allowed).toBe(false);
  });
  it('checks store health for supported old JWTs even when JTI is absent', () => {
    const kit = generateTestLicense('pro');
    setTestLicenseEnv(kit);
    writeFileSync(store, 'invalid');
    expect(verifyLicenseJWT(kit.licenseKey, kit.publicKey)).toMatchObject({
      valid: false,
      code: 'revocation-unavailable',
    });
  });
  it('retains a genuinely absent store as the supported initial state', () => {
    expect(isRevokedJti('new')).toBe(false);
    revokeJti('new');
    expect(isRevokedJti('new')).toBe(true);
    refreshLicense();
  });
});

describe('revocation writer conflicts', () => {
  it('fails a competing writer and blocks paid authorization while a write is pending', () => {
    activeLicense();
    writeFileSync(`${store}.lock`, 'synthetic-operation');
    expect(() => revokeJti('competing-jti')).toThrow(RevocationStateError);
    expect(readFileSync(`${store}.lock`, 'utf8')).toBe('synthetic-operation');
    expect(guardRpcMethod('agent.spawn').allowed).toBe(false);
    expect(guardRpcMethod('session.end').allowed).toBe(true);
  });
  it('treats a dangling lock symlink as unavailable rather than a missing lock', () => {
    activeLicense();
    symlinkSync(join(dir, 'absent-operation'), `${store}.lock`);
    expect(() => revokeJti('competing-jti')).toThrow(RevocationStateError);
    expect(guardRpcMethod('agent.spawn').allowed).toBe(false);
    expect(guardRpcMethod('session.end').allowed).toBe(true);
  });
  it('preserves all successful revocations and deduplicates retries', () => {
    revokeJti('first');
    revokeJti('second');
    revokeJti('first');
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ jtis: ['first', 'second'] });
  });
});

describe('concurrent local revocation transactions', () => {
  it('retains every successful write and explicitly rejects conflicting writers', async () => {
    revokeJti('prior');
    const moduleUrl = new URL('../revoked-jtis.ts', import.meta.url).href;
    const children = Array.from(
      { length: 4 },
      (_, writer) =>
        new Promise<string[]>((resolve, reject) => {
          const code = `const { revokeJti, RevocationStateError } = await import(${JSON.stringify(moduleUrl)});
        for (let i = 0; i < 20; i++) {
          const token = 'writer-${writer}-' + i;
          try { revokeJti(token); console.log(token); }
          catch (error) { if (!(error instanceof RevocationStateError) || error.cause?.code !== 'EEXIST') throw error; }
        }`;
          const child = spawn(
            process.execPath,
            ['--experimental-strip-types', '--input-type=module', '-e', code],
            {
              env: { ...process.env, REVEALUI_REVOKED_JTI_FILE: store },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          let output = '';
          let errors = '';
          child.stdout.on('data', (chunk) => {
            output += chunk;
          });
          child.stderr.on('data', (chunk) => {
            errors += chunk;
          });
          child.on('error', reject);
          child.on('close', (status) =>
            status === 0
              ? resolve(output.trim().split('\n').filter(Boolean))
              : reject(new Error(errors)),
          );
        }),
    );
    const accepted = (await Promise.all(children)).flat();
    expect(accepted.length).toBeGreaterThan(0);
    const recorded = JSON.parse(readFileSync(store, 'utf8')).jtis;
    expect(new Set(recorded)).toEqual(new Set(['prior', ...accepted]));
    expect(() => isRevokedJti('prior')).not.toThrow();
  });
});
