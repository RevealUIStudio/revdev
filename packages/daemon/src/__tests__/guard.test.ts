import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  guardRpcMethod,
  initLicenseGuard,
  licenseErrorResponse,
  refreshLicense,
} from '../guard.js';
import { LICENSE_TIER_HELP, METHOD_MIN_TIER } from '../license.js';
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
      'session.attach',
      // Local-inference RUN surface (aiLocal = FREE) — split out of the old
      // "inference.* is Pro" grouping per GAP-267.
      'inference.status',
      'inference.chat',
      'inference.generate',
      // GAP-337: monitoring without a Pro license
      'harness.health',
    ];

    for (const method of exemptMethods) {
      it(`allows "${method}" on free tier`, () => {
        const result = guardRpcMethod(method);
        expect(result.allowed).toBe(true);
      });
    }
  });

  describe('gated Pro methods on free tier (-32001, requiredTier pro)', () => {
    const proMethods = [
      'agent.spawn',
      'agent.stop',
      'agent.input',
      'merge.request',
      'merge.status',
      'tasks.create',
      'mail.send',
      'files.reserve',
      'events.query',
      'worktree.create',
    ];

    for (const method of proMethods) {
      it(`blocks "${method}" without license`, () => {
        const result = guardRpcMethod(method);
        expect(result.allowed).toBe(false);
        expect(result.tier).toBe('free');
        expect(result.requiredTier).toBe('pro');
        expect(result.reason).toContain('requires a Pro');
      });
    }
  });

  describe('gated Max methods on free tier (-32001, requiredTier max)', () => {
    // memory.* is the concrete leak GAP-267 closes; inference.pull/start/stop
    // is local-model MANAGEMENT (Max), distinct from the free run surface.
    const maxMethods = [
      'memory.store',
      'memory.query',
      'inference.pull',
      'inference.start',
      'inference.stop',
    ];

    for (const method of maxMethods) {
      it(`blocks "${method}" without license`, () => {
        const result = guardRpcMethod(method);
        expect(result.allowed).toBe(false);
        expect(result.tier).toBe('free');
        expect(result.requiredTier).toBe('max');
        expect(result.reason).toContain('requires a Max');
      });
    }
  });

  describe('pro license grants Pro-tier access (but NOT Max)', () => {
    beforeEach(() => {
      setTestLicenseEnv(generateTestLicense('pro'));
      refreshLicense();
    });

    it('allows agent.spawn', () => {
      const result = guardRpcMethod('agent.spawn');
      expect(result.allowed).toBe(true);
      expect(result.tier).toBe('pro');
    });

    it('allows inference.status (free run surface)', () => {
      const result = guardRpcMethod('inference.status');
      expect(result.allowed).toBe(true);
    });

    it('allows merge.request', () => {
      const result = guardRpcMethod('merge.request');
      expect(result.allowed).toBe(true);
    });

    // GAP-267: the whole point — a $49 Pro JWT must NOT unlock Max-marketed
    // memory.*. Previously this returned { allowed: true }.
    it('BLOCKS memory.store (Max-only) with -32001 requiredTier max', () => {
      const result = guardRpcMethod('memory.store');
      expect(result.allowed).toBe(false);
      expect(result.tier).toBe('pro');
      expect(result.requiredTier).toBe('max');
      expect(result.reason).toContain('requires a Max');
    });

    it('BLOCKS inference.pull (Max-only model management)', () => {
      const result = guardRpcMethod('inference.pull');
      expect(result.allowed).toBe(false);
      expect(result.requiredTier).toBe('max');
    });

    // Pro keeps the full multi-agent coordination surface.
    const proCoordination = [
      'agent.stop',
      'merge.status',
      'tasks.create',
      'tasks.claim',
      'mail.send',
      'mail.broadcast',
      'files.reserve',
      'files.release',
      'events.log',
      'events.query',
      // harness.health is FREE (GAP-337); prune stays Pro coordination
      'harness.prune',
      'worktree.create',
    ];
    for (const method of proCoordination) {
      it(`allows "${method}" on pro tier`, () => {
        expect(guardRpcMethod(method).allowed).toBe(true);
      });
    }

    it('allows harness.health on free and pro (GAP-337)', () => {
      expect(guardRpcMethod('harness.health').allowed).toBe(true);
    });
  });

  describe('max/enterprise licenses', () => {
    it('allows Max-tier methods (memory/inference management) with max license', () => {
      setTestLicenseEnv(generateTestLicense('max'));
      refreshLicense();
      expect(guardRpcMethod('memory.store').allowed).toBe(true);
      expect(guardRpcMethod('memory.store').tier).toBe('max');
      expect(guardRpcMethod('memory.query').allowed).toBe(true);
      expect(guardRpcMethod('inference.pull').allowed).toBe(true);
      expect(guardRpcMethod('inference.start').allowed).toBe(true);
      expect(guardRpcMethod('inference.stop').allowed).toBe(true);
    });

    it('allows Pro-tier methods with max license', () => {
      setTestLicenseEnv(generateTestLicense('max'));
      refreshLicense();
      expect(guardRpcMethod('agent.spawn').allowed).toBe(true);
      expect(guardRpcMethod('agent.spawn').tier).toBe('max');
      expect(guardRpcMethod('merge.request').allowed).toBe(true);
    });

    it('allows everything (Pro + Max) with enterprise license', () => {
      setTestLicenseEnv(generateTestLicense('enterprise'));
      refreshLicense();
      expect(guardRpcMethod('merge.request').allowed).toBe(true);
      expect(guardRpcMethod('merge.request').tier).toBe('enterprise');
      expect(guardRpcMethod('memory.store').allowed).toBe(true);
      expect(guardRpcMethod('inference.pull').allowed).toBe(true);
    });
  });

  // CLI --help must not re-introduce the old "pro includes memory" lie.
  describe('LICENSE_TIER_HELP (CLI honesty)', () => {
    it('places memory under max and free file/git under free', () => {
      expect(LICENSE_TIER_HELP).toMatch(/free\s+Sessions, single-repo file\/git/);
      expect(LICENSE_TIER_HELP).toMatch(/max\s+\+ full AI memory \(memory\.\*\)/);
      // Pro line must not claim memory
      const proLine = LICENSE_TIER_HELP.split('\n').find((l) => l.trimStart().startsWith('pro'));
      expect(proLine).toBeDefined();
      expect(proLine).not.toMatch(/memory/i);
    });
  });

  // Parameterized over the authoritative METHOD_MIN_TIER map: every Max method
  // is -32001 on Pro (requiredTier max) and allowed on Max. If a method is
  // added to METHOD_MIN_TIER, it is covered here automatically.
  describe('per-Max-method tier enforcement (parameterized)', () => {
    for (const [method, minTier] of METHOD_MIN_TIER) {
      it(`"${method}" (min ${minTier}) is blocked on Pro`, () => {
        setTestLicenseEnv(generateTestLicense('pro'));
        refreshLicense();
        const result = guardRpcMethod(method);
        expect(result.allowed).toBe(false);
        expect(result.requiredTier).toBe(minTier);
      });

      it(`"${method}" (min ${minTier}) is allowed on ${minTier}`, () => {
        // METHOD_MIN_TIER never holds 'free' (exempt methods aren't in it); the
        // guard both documents that and narrows the type for generateTestLicense.
        if (minTier === 'free') return;
        setTestLicenseEnv(generateTestLicense(minTier));
        refreshLicense();
        expect(guardRpcMethod(method).allowed).toBe(true);
      });
    }
  });

  // ADR zero-9P P0: all single-repo file/git I/O is FREE; multi-agent
  // coordination stays Pro (memory.* / inference-management are Max). This
  // locks the boundary so a future EXEMPT_METHODS edit can't accidentally
  // exempt a gated method or re-gate a free one.
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

    // Gated coordination methods still blocked on free (memory.* is now Max,
    // not Pro, but still -32001 for an unlicensed caller).
    const gatedCoordinationMethods = [
      'agent.spawn',
      'merge.request',
      'mail.send',
      'tasks.create',
      'files.reserve',
      'memory.store',
    ];

    for (const method of gatedCoordinationMethods) {
      it(`still blocks gated method "${method}" on free tier`, () => {
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

// CI enumeration guard (GAP-267): every RPC method the daemon actually
// registers must be classified into exactly one tier bucket — EXEMPT (free),
// METHOD_MIN_TIER (max), or KNOWN_PRO_METHODS (the pro default). A new handler
// with no classification fails this test loudly, so tier coverage can never
// silently regress.
describe('handler tier-classification coverage', () => {
  const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  // Pin to free tier so guardRpcMethod's allow⇔exempt equivalence holds
  // regardless of prior tests' cached license state.
  beforeEach(() => {
    clearTestLicenseEnv();
    refreshLicense();
  });
  afterEach(() => {
    clearTestLicenseEnv();
    refreshLicense();
  });

  /** Statically scan src for `registerHandler('<method>'` first-arg literals. */
  function registeredMethods(): Set<string> {
    const methods = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const src = readFileSync(full, 'utf-8');
        let idx = src.indexOf('registerHandler(');
        while (idx !== -1) {
          const open = src.indexOf("'", idx);
          const close = open === -1 ? -1 : src.indexOf("'", open + 1);
          // Guard against runaway matches (a comment without a nearby literal).
          if (open !== -1 && close !== -1 && close - open < 60) {
            methods.add(src.slice(open + 1, close));
          }
          idx = src.indexOf('registerHandler(', idx + 1);
        }
      }
    };
    walk(SRC_DIR);
    return methods;
  }

  // Every non-exempt, non-Max method the daemon registers. Hand-maintained:
  // adding a handler without adding it here (or to EXEMPT/METHOD_MIN_TIER)
  // fails the coverage test below — the intended failure mode.
  const KNOWN_PRO_METHODS = new Set([
    // agent PTY + lifecycle
    'agent.spawn',
    'agent.stop',
    'agent.list',
    'agent.remove',
    'agent.input',
    'agent.output',
    'agent.streamTicket',
    'agent.resize',
    // HTTP gateway token management (GAP-421 guardrail-2 remediation S5)
    'gateway.revokeToken',
    // merge pipeline
    'merge.request',
    'merge.status',
    'merge.list',
    'merge.update',
    // mailbox
    'mail.send',
    'mail.broadcast',
    'mail.inbox',
    'mail.markRead',
    // task board
    'tasks.create',
    'tasks.claim',
    'tasks.complete',
    'tasks.list',
    'tasks.release',
    // file reservations
    'files.reserve',
    'files.release',
    'files.check',
    'files.list',
    // event log
    'events.log',
    'events.query',
    // harness.prune stays Pro; harness.health is FREE (GAP-337 / EXEMPT_METHODS)
    'harness.prune',
    // worktrees
    'worktree.create',
    'worktree.list',
    'worktree.remove',
    // project grant surface (project.open is FREE/exempt)
    'project.grant',
    'project.revoke',
    // agent identity rotation
    'identity.rotate',
  ]);

  it('scans a plausible number of registered handlers', () => {
    // Sanity floor so a broken scanner (finding nothing) can't pass silently.
    expect(registeredMethods().size).toBeGreaterThanOrEqual(50);
  });

  it('classifies every registered handler into exactly one tier bucket', () => {
    const unclassified: string[] = [];
    for (const method of registeredMethods()) {
      const exempt = guardRpcMethod(method).allowed; // free-tier pass ⇒ exempt
      const isMax = METHOD_MIN_TIER.has(method);
      const isPro = KNOWN_PRO_METHODS.has(method);
      // Exactly one bucket. (Exempt short-circuits before tier logic; Max/Pro
      // are mutually exclusive sets.)
      const buckets = [exempt, isMax, isPro].filter(Boolean).length;
      if (buckets !== 1) unclassified.push(`${method} (buckets=${buckets})`);
    }
    expect(unclassified).toEqual([]);
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
    const guard = {
      allowed: false as const,
      tier: 'pro' as const,
      requiredTier: 'max' as const,
      reason: 'test reason',
    };
    const raw = licenseErrorResponse(1, guard);
    const parsed = JSON.parse(raw);

    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.error.code).toBe(-32001);
    expect(parsed.error.message).toBe('License required');
    expect(parsed.error.data.tier).toBe('pro');
    expect(parsed.error.data.requiredTier).toBe('max');
    expect(parsed.error.data.reason).toBe('test reason');
    expect(parsed.error.data.upgradeUrl).toBe('https://revealui.com/pro');
  });

  it('handles null id', () => {
    const guard = { allowed: false as const, tier: 'free' as const, reason: 'blocked' };
    const parsed = JSON.parse(licenseErrorResponse(null, guard));
    expect(parsed.id).toBeNull();
  });
});
