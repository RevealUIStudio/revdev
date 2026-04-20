import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getLicenseState,
  guardRpcMethod,
  initLicenseGuard,
  licenseErrorResponse,
  refreshLicense,
} from '../guard.js';

describe('guardRpcMethod', () => {
  const originalEnv = process.env.REVEALUI_LICENSE_KEY;

  beforeEach(async () => {
    delete process.env.REVEALUI_LICENSE_KEY;
    delete process.env.REVEALUI_LICENSE_PUBLIC_KEY;
    await refreshLicense();
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env.REVEALUI_LICENSE_KEY = originalEnv;
    } else {
      delete process.env.REVEALUI_LICENSE_KEY;
    }
    await refreshLicense();
  });

  describe('exempt methods (always allowed)', () => {
    const exemptMethods = [
      'ping',
      'session.register',
      'session.attach',
      'session.update',
      'session.end',
      'session.list',
      'harness.health',
    ];

    for (const method of exemptMethods) {
      it(`allows "${method}" on free tier`, () => {
        const result = guardRpcMethod(method);
        expect(result.allowed).toBe(true);
      });
    }
  });

  describe('gated methods on free tier (no license key)', () => {
    const gatedMethods = [
      'agent.spawn',
      'agent.stop',
      'agent.input',
      'inference.status',
      'inference.pull',
      'merge.request',
      'merge.status',
      'memory.store',
      'memory.query',
      'harness.execute',
      'worktree.create',
      'tasks.create',
      'mail.send',
      'files.reserve',
      'events.query',
    ];

    for (const method of gatedMethods) {
      it(`blocks "${method}" without license`, () => {
        const result = guardRpcMethod(method);
        expect(result.allowed).toBe(false);
        expect(result.tier).toBe('free');
        expect(result.reason).toContain('requires a higher license tier');
      });
    }
  });

  describe('invalid license keys', () => {
    it('treats malformed key as free tier', async () => {
      process.env.REVEALUI_LICENSE_KEY = 'not-a-valid-key';
      await refreshLicense();
      const result = guardRpcMethod('agent.spawn');
      expect(result.allowed).toBe(false);
      expect(result.tier).toBe('free');
    });

    it('treats empty key as free tier', async () => {
      process.env.REVEALUI_LICENSE_KEY = '';
      await refreshLicense();
      const result = guardRpcMethod('agent.spawn');
      expect(result.allowed).toBe(false);
    });
  });
});

describe('initLicenseGuard', () => {
  beforeEach(() => {
    delete process.env.REVEALUI_LICENSE_KEY;
    delete process.env.REVEALUI_LICENSE_PUBLIC_KEY;
  });

  it('returns free tier without key', async () => {
    const result = await initLicenseGuard();
    expect(result.tier).toBe('free');
    expect(result.valid).toBe(false);
  });

  it('returns free for invalid JWT (no public key)', async () => {
    process.env.REVEALUI_LICENSE_KEY = 'not.a.jwt';
    const result = await initLicenseGuard();
    expect(result.tier).toBe('free');
    expect(result.valid).toBe(false);
  });
});

describe('getLicenseState', () => {
  it('returns current tier state synchronously after init', async () => {
    delete process.env.REVEALUI_LICENSE_KEY;
    await initLicenseGuard();
    const state = getLicenseState();
    expect(state.tier).toBe('free');
    expect(state.valid).toBe(false);
  });
});

describe('licenseErrorResponse', () => {
  it('returns valid JSON-RPC error', () => {
    const guard = { allowed: false as const, tier: 'free' as const, reason: 'test reason' };
    const raw = licenseErrorResponse(1, guard);
    const parsed = JSON.parse(raw);

    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.error.code).toBe(-32001);
    expect(parsed.error.message).toBe('License required');
    expect(parsed.error.data.tier).toBe('free');
    expect(parsed.error.data.reason).toBe('test reason');
    expect(parsed.error.data.upgradeUrl).toBe('https://revealui.com/pro');
  });

  it('handles null id', () => {
    const guard = { allowed: false as const, tier: 'free' as const, reason: 'blocked' };
    const parsed = JSON.parse(licenseErrorResponse(null, guard));
    expect(parsed.id).toBeNull();
  });
});
