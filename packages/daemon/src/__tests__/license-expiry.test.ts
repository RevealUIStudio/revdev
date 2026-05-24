/**
 * GAP-184 — daemon license-expiry warn/fail behavior + REVEALUI_LICENSE_KEY_FILE.
 *
 * Covers: expiry status buckets (14d/7d/1d), fail-closed on expired, the
 * file-based key source, and the loud config error when KEY_FILE is broken.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLicenseGuard } from '../guard.js';
import {
  checkLicense,
  evaluateLicense,
  LicenseConfigError,
  LicenseExpiredError,
  loadLicenseKey,
} from '../license.js';
import {
  clearTestLicenseEnv,
  generateTestLicense,
  setTestLicenseEnv,
} from './test-license-helper.js';

/** Mint + install a license expiring `days` from now (negative = expired). */
function installLicense(days: number, tier: 'pro' | 'max' | 'enterprise' = 'enterprise') {
  const kit = generateTestLicense(tier, false, { daysUntilExpiry: days });
  setTestLicenseEnv(kit);
  return kit;
}

beforeEach(() => {
  clearTestLicenseEnv();
  delete process.env.REVEALUI_LICENSE_KEY_FILE;
});

afterEach(() => {
  clearTestLicenseEnv();
  delete process.env.REVEALUI_LICENSE_KEY_FILE;
  vi.restoreAllMocks();
});

describe('evaluateLicense — expiry status buckets', () => {
  it('15 days out → ok (no warning bucket)', () => {
    installLicense(15);
    const ev = evaluateLicense();
    expect(ev.valid).toBe(true);
    expect(ev.status).toBe('ok');
    expect(ev.tier).toBe('enterprise');
  });

  it('13 days out → expiring-14d (info)', () => {
    installLicense(13);
    expect(evaluateLicense().status).toBe('expiring-14d');
  });

  it('6 days out → expiring-7d (warn)', () => {
    installLicense(6);
    expect(evaluateLicense().status).toBe('expiring-7d');
  });

  it('12 hours out → expiring-1d (critical)', () => {
    installLicense(0.5);
    const ev = evaluateLicense();
    expect(ev.status).toBe('expiring-1d');
    expect(ev.valid).toBe(true);
    expect(ev.secondsRemaining).toBeGreaterThan(0);
  });

  it('1 hour ago → expired (fail-closed signal)', () => {
    installLicense(-1 / 24);
    const ev = evaluateLicense();
    expect(ev.valid).toBe(false);
    expect(ev.status).toBe('expired');
    expect(ev.present).toBe(true);
    expect(ev.secondsRemaining).toBeLessThan(0);
  });

  it('perpetual (no exp) → perpetual', () => {
    const kit = generateTestLicense('enterprise', true);
    setTestLicenseEnv(kit);
    const ev = evaluateLicense();
    expect(ev.valid).toBe(true);
    expect(ev.status).toBe('perpetual');
    expect(ev.expiresAt).toBeNull();
  });

  it('no key set → absent (free/degraded)', () => {
    const ev = evaluateLicense();
    expect(ev.present).toBe(false);
    expect(ev.valid).toBe(false);
    expect(ev.status).toBe('absent');
  });
});

describe('loadLicenseKey — env / file priority', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'revdev-lic-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads REVEALUI_LICENSE_KEY_FILE when KEY is unset', () => {
    const kit = generateTestLicense('pro', true);
    const file = join(dir, 'license.jwt');
    writeFileSync(file, `${kit.licenseKey}\n`);
    process.env.REVEALUI_LICENSE_KEY_FILE = file;
    process.env.REVDEV_LICENSE_PUBLIC_KEY = kit.publicKey;

    const loaded = loadLicenseKey();
    expect(loaded.source).toBe('file');
    expect(loaded.key).toBe(kit.licenseKey);

    const ev = evaluateLicense();
    expect(ev.valid).toBe(true);
    expect(ev.source).toBe('file');
    expect(ev.tier).toBe('pro');
  });

  it('inline KEY takes priority over KEY_FILE', () => {
    const inline = generateTestLicense('max', true);
    const fileKit = generateTestLicense('pro', true);
    const file = join(dir, 'license.jwt');
    writeFileSync(file, fileKit.licenseKey);
    setTestLicenseEnv(inline);
    process.env.REVEALUI_LICENSE_KEY_FILE = file;

    const loaded = loadLicenseKey();
    expect(loaded.source).toBe('env');
    expect(loaded.key).toBe(inline.licenseKey);
  });

  it('throws LicenseConfigError when KEY_FILE points at a missing path', () => {
    process.env.REVEALUI_LICENSE_KEY_FILE = join(dir, 'does-not-exist.jwt');
    expect(() => loadLicenseKey()).toThrow(LicenseConfigError);
  });

  it('throws LicenseConfigError when KEY_FILE is empty', () => {
    const file = join(dir, 'empty.jwt');
    writeFileSync(file, '   \n');
    process.env.REVEALUI_LICENSE_KEY_FILE = file;
    expect(() => loadLicenseKey()).toThrow(LicenseConfigError);
  });
});

describe('initLicenseGuard — fail-closed + warnings', () => {
  it('FAILS CLOSED (throws LicenseExpiredError) on an expired license', () => {
    installLicense(-1 / 24);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => initLicenseGuard()).toThrow(LicenseExpiredError);
    expect(errSpy).toHaveBeenCalled(); // CRITICAL line emitted before throw
  });

  it('does NOT throw, and logs CRITICAL, at <= 1 day', () => {
    installLicense(0.5);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = initLicenseGuard();
    expect(state.valid).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });

  it('does NOT throw on a healthy (15d) license', () => {
    installLicense(15);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => initLicenseGuard()).not.toThrow();
  });

  it('does NOT throw, runs degraded, when no license is set', () => {
    const state = initLicenseGuard();
    expect(state.valid).toBe(false);
    expect(state.tier).toBe('free');
  });
});

describe('checkLicense — backward-compatible {tier, valid}', () => {
  it('returns valid Pro+ for a perpetual license', () => {
    const kit = generateTestLicense('pro', true);
    setTestLicenseEnv(kit);
    expect(checkLicense()).toEqual({ tier: 'pro', valid: true });
  });

  it('returns free/invalid for an expired license (degraded at the RPC layer)', () => {
    installLicense(-1 / 24);
    expect(checkLicense()).toEqual({ tier: 'free', valid: false });
  });

  it('returns free/invalid when no key is set', () => {
    expect(checkLicense()).toEqual({ tier: 'free', valid: false });
  });
});
