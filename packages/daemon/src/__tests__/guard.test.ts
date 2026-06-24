import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  guardRpcMethod,
  initLicenseGuard,
  licenseErrorResponse,
  refreshLicense,
} from '../guard.js';
import {
  clearTestLicenseEnv,
  generateTestLicense,
  setTestLicenseEnv,
} from './test-license-helper.js';

describe('guardRpcMethod', () => {
  const originalEnv = process.env.REVEALUI_LICENSE_KEY;
  const originalPubKey = process.env.REVDEV_LICENSE_PUBLIC_KEY;

  beforeEach(() => {
    clearTestLicenseEnv();
    refreshLicense();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.REVEALUI_LICENSE_KEY = originalEnv;
    } else {
      delete process.env.REVEALUI_LICENSE_KEY;
    }
    if (originalPubKey !== undefined) {
      process.env.REVDEV_LICENSE_PUBLIC_KEY = originalPubKey;
    } else {
      delete process.env.REVDEV_LICENSE_PUBLIC_KEY;
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
      setTestLicenseEnv(generateTestLicense('pro'));
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
      setTestLicenseEnv(generateTestLicense('max'));
      refreshLicense();
      expect(guardRpcMethod('agent.spawn').allowed).toBe(true);
      expect(guardRpcMethod('agent.spawn').tier).toBe('max');
    });

    it('allows all methods with enterprise license', () => {
      setTestLicenseEnv(generateTestLicense('enterprise'));
      refreshLicense();
      expect(guardRpcMethod('merge.request').allowed).toBe(true);
      expect(guardRpcMethod('merge.request').tier).toBe('enterprise');
    });
  });

  // ADR zero-9P P0: all single-repo file/git I/O is FREE; only multi-agent
  // coordination stays Pro. This locks the boundary so a future EXEMPT_METHODS
  // edit can't accidentally exempt a Pro method or re-gate a free one.
  describe('file/git tier boundary (zero-9P P0)', () => {
    const freeFileGitMethods = [
      'project.open',
      'file.read',
      'file.write',
      'file.delete',
      'file.stat',
      'git.status',
      'git.diffFile',
      'git.diffContent',
      'git.stageFile',
      'git.unstageFile',
      'git.discardFile',
      'git.listBranches',
      'git.createBranch',
      'git.switchBranch',
      'git.deleteBranch',
      'git.log',
      'git.commit',
      'git.push',
      'git.pull',
      'git.readBlobAtHead',
      'git.readBlobAtIndex',
    ];

    for (const method of freeFileGitMethods) {
      it(`allows "${method}" on free tier (not -32001)`, () => {
        const result = guardRpcMethod(method);
        expect(result.allowed).toBe(true);
        expect(result.tier).toBe('free');
      });
    }

    const proCoordinationMethods = [
      'agent.spawn',
      'merge.request',
      'mail.send',
      'tasks.create',
      'files.reserve',
      'memory.store',
      'inference.status',
    ];

    for (const method of proCoordinationMethods) {
      it(`still blocks Pro method "${method}" on free tier`, () => {
        const result = guardRpcMethod(method);
        expect(result.allowed).toBe(false);
        expect(result.tier).toBe('free');
      });
    }
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
    clearTestLicenseEnv();
  });

  afterEach(() => {
    clearTestLicenseEnv();
  });

  it('returns free tier without key', () => {
    const result = initLicenseGuard();
    expect(result.tier).toBe('free');
    expect(result.valid).toBe(false);
  });

  it('returns pro tier with valid v2 key', () => {
    setTestLicenseEnv(generateTestLicense('pro'));
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
