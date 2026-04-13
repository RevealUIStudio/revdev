import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  guardRpcMethod,
  initLicenseGuard,
  licenseErrorResponse,
  refreshLicense,
} from '../guard.js';

describe('guardRpcMethod', () => {
  const originalEnv = process.env.REVEALUI_LICENSE_KEY;

  beforeEach(() => {
    delete process.env.REVEALUI_LICENSE_KEY;
    refreshLicense();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.REVEALUI_LICENSE_KEY = originalEnv;
    } else {
      delete process.env.REVEALUI_LICENSE_KEY;
    }
    refreshLicense();
  });

  describe('exempt methods (always allowed)', () => {
    const exemptMethods = [
      'ping',
      'session.register',
      'session.update',
      'session.end',
      'session.list',
    ];

    for (const method of exemptMethods) {
      it(`allows "${method}" on free tier`, () => {
        const result = guardRpcMethod(method);
        expect(result.allowed).toBe(true);
      });
    }
  });

  describe('gated methods on free tier', () => {
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
        expect(result.reason).toContain('requires a Pro');
      });
    }
  });

  describe('pro license grants full access', () => {
    beforeEach(() => {
      process.env.REVEALUI_LICENSE_KEY = 'RVUI-pro-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
      refreshLicense();
    });

    it('allows agent.spawn', () => {
      const result = guardRpcMethod('agent.spawn');
      expect(result.allowed).toBe(true);
      expect(result.tier).toBe('pro');
    });

    it('allows inference.status', () => {
      const result = guardRpcMethod('inference.status');
      expect(result.allowed).toBe(true);
    });

    it('allows merge.request', () => {
      const result = guardRpcMethod('merge.request');
      expect(result.allowed).toBe(true);
    });

    it('allows memory.store', () => {
      const result = guardRpcMethod('memory.store');
      expect(result.allowed).toBe(true);
    });
  });

  describe('max/enterprise licenses', () => {
    it('allows all methods with max license', () => {
      process.env.REVEALUI_LICENSE_KEY = 'RVUI-max-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
      refreshLicense();
      expect(guardRpcMethod('agent.spawn').allowed).toBe(true);
      expect(guardRpcMethod('agent.spawn').tier).toBe('max');
    });

    it('allows all methods with enterprise license', () => {
      process.env.REVEALUI_LICENSE_KEY = 'RVUI-enterprise-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
      refreshLicense();
      expect(guardRpcMethod('merge.request').allowed).toBe(true);
      expect(guardRpcMethod('merge.request').tier).toBe('enterprise');
    });
  });

  describe('invalid license keys', () => {
    it('treats malformed key as free tier', () => {
      process.env.REVEALUI_LICENSE_KEY = 'not-a-valid-key';
      refreshLicense();
      const result = guardRpcMethod('agent.spawn');
      expect(result.allowed).toBe(false);
      expect(result.tier).toBe('free');
    });

    it('treats empty key as free tier', () => {
      process.env.REVEALUI_LICENSE_KEY = '';
      refreshLicense();
      const result = guardRpcMethod('agent.spawn');
      expect(result.allowed).toBe(false);
    });
  });
});

describe('initLicenseGuard', () => {
  beforeEach(() => {
    delete process.env.REVEALUI_LICENSE_KEY;
  });

  it('returns free tier without key', () => {
    const result = initLicenseGuard();
    expect(result.tier).toBe('free');
    expect(result.valid).toBe(false);
  });

  it('returns pro tier with valid key', () => {
    process.env.REVEALUI_LICENSE_KEY = 'RVUI-pro-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    const result = initLicenseGuard();
    expect(result.tier).toBe('pro');
    expect(result.valid).toBe(true);
  });

  it('logs startup banner', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    initLicenseGuard();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('FREE'));
    spy.mockRestore();
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
