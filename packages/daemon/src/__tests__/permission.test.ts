/**
 * GAP-294 Phase 0 — action-class map + shadow evaluation.
 * §9 agent-scope grant unit + PGlite issue/consume/revoke.
 */

import { PGlite } from '@electric-sql/pglite';
import { RPC_METHODS } from '@revdev/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrations/index.js';
import {
  ApprovalRequiredError,
  classifyMethod,
  decideApproval,
  decideEnforcement,
  denyPathCandidates,
  enforceSkillTool,
  evaluateShadow,
  expectedClassifiedMethods,
  expireStaleApprovals,
  grantCoversMethod,
  grantRootMatches,
  issueGrant,
  isTrustedOperator,
  listGrants,
  listPendingApprovals,
  METHOD_ACTION_CLASS,
  PermissionFloodError,
  parseSessionPermissionMode,
  pathMatchesDenyPrefix,
  queueApprovalRequired,
  resolvePermissionMode,
  revokeGrant,
  shadowWouldAuto,
  shadowWouldManual,
  summarizeParams,
  tryConsumeGrant,
} from '../permission.js';
import { migrate } from '../storage/migrate.js';

const DB_TEST_TIMEOUT = 60_000;

describe('METHOD_ACTION_CLASS coverage', () => {
  it('classifies every RPC_METHODS value', () => {
    for (const method of Object.values(RPC_METHODS)) {
      expect(
        METHOD_ACTION_CLASS.has(method),
        `RPC method ${method} missing from METHOD_ACTION_CLASS`,
      ).toBe(true);
    }
  });

  it('classifies expectedClassifiedMethods without gaps for protocol set', () => {
    const expected = new Set(expectedClassifiedMethods());
    for (const method of Object.values(RPC_METHODS)) {
      expect(expected.has(method)).toBe(true);
    }
  });

  it('unmapped method fails closed to critical', () => {
    expect(classifyMethod('totally.unknown.method')).toBe('critical');
  });
});

describe('shadow would (manual simulation)', () => {
  it('routine allows', () => {
    expect(shadowWouldManual('routine')).toBe('allow');
  });
  it('consequential and critical require approval', () => {
    expect(shadowWouldManual('consequential')).toBe('require_approval');
    expect(shadowWouldManual('critical')).toBe('require_approval');
  });
});

describe('shadow would (auto simulation)', () => {
  it('routine and consequential allow; critical requires approval', () => {
    expect(shadowWouldAuto('routine')).toBe('allow');
    expect(shadowWouldAuto('consequential')).toBe('allow');
    expect(shadowWouldAuto('critical')).toBe('require_approval');
  });
});

describe('evaluateShadow', () => {
  afterEach(() => {
    delete process.env.REVDEV_PERMISSION_SHADOW_AS;
  });

  it('ping is routine would_allow under default manual shadow-as', () => {
    const r = evaluateShadow('ping');
    expect(r.actionClass).toBe('routine');
    expect(r.would).toBe('allow');
    expect(r.eventType).toBe('permission.would_allow');
  });

  it('git.push is critical would_require_approval under manual shadow-as', () => {
    process.env.REVDEV_PERMISSION_SHADOW_AS = 'manual';
    const r = evaluateShadow('git.push');
    expect(r.actionClass).toBe('critical');
    expect(r.would).toBe('require_approval');
    expect(r.eventType).toBe('permission.would_require_approval');
  });

  it('file.write is consequential allow under auto shadow-as', () => {
    process.env.REVDEV_PERMISSION_SHADOW_AS = 'auto';
    const r = evaluateShadow('file.write');
    expect(r.actionClass).toBe('consequential');
    expect(r.would).toBe('allow');
    expect(r.eventType).toBe('permission.would_allow');
  });

  it('agent.spawn is critical require_approval even under auto shadow-as', () => {
    process.env.REVDEV_PERMISSION_SHADOW_AS = 'auto';
    const r = evaluateShadow('agent.spawn');
    expect(r.actionClass).toBe('critical');
    expect(r.would).toBe('require_approval');
  });

  it('skills.tool.Bash is critical under auto shadow-as', () => {
    process.env.REVDEV_PERMISSION_SHADOW_AS = 'auto';
    const r = evaluateShadow('skills.tool.Bash');
    expect(r.actionClass).toBe('critical');
    expect(r.would).toBe('require_approval');
  });
});

describe('owner-countersigned judgment calls', () => {
  it('git.pull is consequential (not critical)', () => {
    expect(classifyMethod('git.pull')).toBe('consequential');
  });
  it('git.deleteBranch is consequential; git.discardFile is critical', () => {
    expect(classifyMethod('git.deleteBranch')).toBe('consequential');
    expect(classifyMethod('git.discardFile')).toBe('critical');
  });
  it('agent.input is consequential; agent.stop is routine', () => {
    expect(classifyMethod('agent.input')).toBe('consequential');
    expect(classifyMethod('agent.stop')).toBe('routine');
  });
  it('memory.store is routine', () => {
    expect(classifyMethod('memory.store')).toBe('routine');
  });
  it('skills.invoke stays routine; Bash tool is critical; Read/Grep/Glob are routine', () => {
    expect(classifyMethod('skills.invoke')).toBe('routine');
    expect(classifyMethod('skills.tool.Read')).toBe('routine');
    expect(classifyMethod('skills.tool.Grep')).toBe('routine');
    expect(classifyMethod('skills.tool.Glob')).toBe('routine');
    expect(classifyMethod('skills.tool.Bash')).toBe('critical');
  });
});

describe('decideEnforcement (Phase 1)', () => {
  afterEach(() => {
    delete process.env.REVDEV_PERMISSION_MODE;
    delete process.env.REVDEV_PERMISSION_DENY_METHODS;
  });

  it('shadow mode is not used by decideEnforcement callers for block', () => {
    // decideEnforcement under manual requires approval for critical
    const d = decideEnforcement('git.push', 'manual');
    expect(d.action).toBe('require_approval');
  });

  it('manual allows routine', () => {
    expect(decideEnforcement('ping', 'manual').action).toBe('allow');
  });

  it('auto allows consequential and requires approval for critical', () => {
    expect(decideEnforcement('file.write', 'auto').action).toBe('allow');
    expect(decideEnforcement('agent.spawn', 'auto').action).toBe('require_approval');
    expect(decideEnforcement('skills.tool.Bash', 'auto').action).toBe('require_approval');
    expect(decideEnforcement('skills.tool.Read', 'manual').action).toBe('allow');
  });

  it('deny-list absorbs consequential calls in auto', () => {
    process.env.REVDEV_PERMISSION_DENY_METHODS = 'git.pull,file.write';
    expect(decideEnforcement('git.pull', 'auto').action).toBe('deny');
  });

  it('critical floor wins over the deny-list in auto', () => {
    process.env.REVDEV_PERMISSION_DENY_METHODS = 'git.push';
    expect(decideEnforcement('git.push', 'auto').action).toBe('require_approval');
  });

  it('path-prefix deny-list absorbs in auto and does not use regex', () => {
    process.env.REVDEV_PERMISSION_DENY_PREFIXES = 'secrets, src/private';
    const denied = decideEnforcement('file.write', 'auto', process.env, {
      repoPath: '/tmp/proj',
      filePath: 'secrets/token',
    });
    expect(denied.action).toBe('deny');
    const allowed = decideEnforcement('file.write', 'auto', process.env, {
      repoPath: '/tmp/proj',
      filePath: 'src/app.ts',
    });
    expect(allowed.action).toBe('allow');
    expect(pathMatchesDenyPrefix('src/app.ts', ['src/app.ts.bak'])).toBe(false);
  });

  it('manual stays on the approval matrix when a deny-list is configured', () => {
    process.env.REVDEV_PERMISSION_DENY_METHODS = 'file.write';
    expect(decideEnforcement('file.write', 'manual').action).toBe('require_approval');
  });

  it('agent-scoped allows routine and requires approval until grant is consulted', () => {
    expect(decideEnforcement('ping', 'agent-scoped').action).toBe('allow');
    const c = decideEnforcement('file.write', 'agent-scoped');
    expect(c.action).toBe('require_approval');
    if (c.action === 'require_approval') {
      expect(c.reason).toBe('agent_scoped');
    }
    const k = decideEnforcement('git.push', 'agent-scoped');
    expect(k.action).toBe('require_approval');
    if (k.action === 'require_approval') {
      expect(k.reason).toBe('agent_scoped');
    }
  });
});

describe('grantCoversMethod (GAP-294 §9)', () => {
  it('consequential class covers file.write but not git.push', () => {
    const g = { classes: ['consequential'], methods: [] as string[] };
    expect(grantCoversMethod(g, 'file.write', 'consequential')).toBe(true);
    expect(grantCoversMethod(g, 'git.push', 'critical')).toBe(false);
  });

  it('critical only by explicit method name', () => {
    const byClass = { classes: ['consequential'], methods: [] as string[] };
    expect(grantCoversMethod(byClass, 'agent.spawn', 'critical')).toBe(false);
    const byMethod = { classes: [] as string[], methods: ['agent.spawn'] };
    expect(grantCoversMethod(byMethod, 'agent.spawn', 'critical')).toBe(true);
    expect(grantCoversMethod(byMethod, 'git.push', 'critical')).toBe(false);
  });

  it('explicit method covers consequential even without class', () => {
    const g = { classes: [] as string[], methods: ['file.write'] };
    expect(grantCoversMethod(g, 'file.write', 'consequential')).toBe(true);
  });
});

describe('grantRootMatches', () => {
  it('null root always matches', () => {
    expect(grantRootMatches(null, { filePath: '/var/tmp/x' })).toBe(true);
  });
  it('prefix matches under root', () => {
    expect(grantRootMatches('/tmp/proj', { filePath: '/tmp/proj/src/a.ts' })).toBe(true);
    expect(grantRootMatches('/tmp/proj', { filePath: '/tmp/other/x' })).toBe(false);
  });
  it('no pathish in params does not reject', () => {
    expect(grantRootMatches('/tmp/proj', { branch: 'main' })).toBe(true);
  });
});

describe('resolvePermissionMode (default stays shadow)', () => {
  const env = {} as NodeJS.ProcessEnv;

  it('unset and blank stay shadow', () => {
    expect(resolvePermissionMode(env)).toBe('shadow');
    expect(resolvePermissionMode({ REVDEV_PERMISSION_MODE: '  ' })).toBe('shadow');
  });

  it('known modes pass through', () => {
    expect(resolvePermissionMode({ REVDEV_PERMISSION_MODE: 'auto' })).toBe('auto');
    expect(resolvePermissionMode({ REVDEV_PERMISSION_MODE: 'MANUAL' })).toBe('manual');
    expect(resolvePermissionMode({ REVDEV_PERMISSION_MODE: 'agent-scoped' })).toBe('agent-scoped');
    expect(resolvePermissionMode({ REVDEV_PERMISSION_MODE: 'shadow' })).toBe('shadow');
  });

  it('unknown value fails closed to manual', () => {
    expect(resolvePermissionMode({ REVDEV_PERMISSION_MODE: 'bypass' })).toBe('manual');
  });
});

describe('summarizeParams (design §6.2)', () => {
  it('names the path, the push target, and the spawn argv head', () => {
    expect(summarizeParams('file.write', { filePath: 'src/a.ts', content: 'x' })).toBe(
      'file.write src/a.ts',
    );
    expect(summarizeParams('git.push', { remote: 'origin', branch: 'test' })).toBe(
      'git.push origin test',
    );
    expect(summarizeParams('agent.spawn', { command: 'pnpm', args: ['test', 'permission'] })).toBe(
      'agent.spawn pnpm test permission',
    );
  });
});

describe('deny path candidates', () => {
  it('keeps repoPath as the root and relativizes a file under it', () => {
    expect(denyPathCandidates({ repoPath: '/tmp/proj', filePath: '/tmp/proj/secrets/a' })).toEqual([
      '/tmp/proj/secrets/a',
      'secrets/a',
    ]);
  });
});

describe('isTrustedOperator (design §6.4)', () => {
  it('matches only the agentId:fingerprint pair', () => {
    const entries = new Set(['op-1:fp-aaa']);
    expect(isTrustedOperator(entries, 'op-1', 'fp-aaa')).toBe(true);
    expect(isTrustedOperator(entries, 'op-1', 'fp-bbb')).toBe(false);
    expect(isTrustedOperator(entries, 'other', 'fp-aaa')).toBe(false);
    expect(isTrustedOperator(entries, 'op-1', null)).toBe(false);
  });
});

describe('parseSessionPermissionMode (Phase 2)', () => {
  it('accepts valid modes', () => {
    expect(parseSessionPermissionMode('manual')).toBe('manual');
    expect(parseSessionPermissionMode('AUTO')).toBe('auto');
    expect(parseSessionPermissionMode('agent-scoped')).toBe('agent-scoped');
    expect(parseSessionPermissionMode('shadow')).toBe('shadow');
  });
  it('null/empty clears override', () => {
    expect(parseSessionPermissionMode(null)).toBe(null);
    expect(parseSessionPermissionMode('')).toBe(null);
  });
  it('rejects unknown', () => {
    expect(parseSessionPermissionMode('bypass')).toBe(null);
    expect(parseSessionPermissionMode(12)).toBe(null);
  });
  it('permission.setMode is critical', () => {
    expect(classifyMethod('permission.setMode')).toBe('critical');
  });
  it('permission.grant and revokeGrant are critical; listGrants is routine', () => {
    expect(classifyMethod('permission.grant')).toBe('critical');
    expect(classifyMethod('permission.revokeGrant')).toBe('critical');
    expect(classifyMethod('permission.listGrants')).toBe('routine');
  });
});

describe('enforceSkillTool (GAP-294 skill tools)', () => {
  let db: PGlite;

  afterEach(async () => {
    delete process.env.REVDEV_PERMISSION_MODE;
    await db?.close().catch(() => {});
  });

  it(
    'shadow allows Bash; manual queues then consumes a single-use approval',
    async () => {
      db = new PGlite();
      await migrate(db, [...MIGRATIONS]);
      const params = { command: 'echo skill-ok' };

      process.env.REVDEV_PERMISSION_MODE = 'shadow';
      await enforceSkillTool('Bash', params, { db, agentId: 'agent-a' });

      process.env.REVDEV_PERMISSION_MODE = 'manual';
      await expect(
        enforceSkillTool('Bash', params, { db, agentId: 'agent-a' }),
      ).rejects.toBeInstanceOf(ApprovalRequiredError);

      const pending = await db.query<{ id: string }>(
        `SELECT id FROM pending_approvals WHERE agent_id = $1 AND method = $2 AND status = 'pending'`,
        ['agent-a', 'skills.tool.Bash'],
      );
      const pendingId = pending.rows[0]?.id;
      expect(pendingId).toBeTruthy();
      if (!pendingId) {
        throw new Error('expected a pending skills.tool.Bash approval');
      }
      await decideApproval(db, pendingId, 'approved', 'op-1');

      await enforceSkillTool('Bash', params, { db, agentId: 'agent-a' });

      await expect(
        enforceSkillTool('Bash', params, { db, agentId: 'agent-a' }),
      ).rejects.toBeInstanceOf(ApprovalRequiredError);
    },
    DB_TEST_TIMEOUT,
  );

  it('Read stays allowed in manual without an approval', async () => {
    db = new PGlite();
    await migrate(db, [...MIGRATIONS]);
    process.env.REVDEV_PERMISSION_MODE = 'manual';
    await enforceSkillTool('Read', { path: 'note.txt' }, { db, agentId: 'agent-a' });
  });
});

describe('approval queue audit (design §6)', () => {
  let db: PGlite;

  afterEach(async () => {
    await db?.close().catch(() => {});
  });

  it(
    'expires a stale pending row and writes permission.expired',
    async () => {
      db = new PGlite();
      await migrate(db, [...MIGRATIONS]);
      await db.query(
        `INSERT INTO pending_approvals (id, agent_id, method, params_hash, summary, expires_at, status)
         VALUES ('ap-old', 'agent-a', 'git.push', 'hash', 'git.push', NOW() - INTERVAL '1 minute', 'pending')`,
      );
      await expireStaleApprovals(db);
      const row = await db.query<{ status: string }>(
        `SELECT status FROM pending_approvals WHERE id = 'ap-old'`,
      );
      expect(row.rows[0]?.status).toBe('expired');
      const events = await db.query<{ event_type: string }>(
        `SELECT event_type FROM events WHERE event_type = 'permission.expired'`,
      );
      expect(events.rows.length).toBe(1);
      expect(await listPendingApprovals(db)).toEqual([]);
    },
    DB_TEST_TIMEOUT,
  );

  it(
    'returns -32004 at the flood cap without inserting another row',
    async () => {
      db = new PGlite();
      await migrate(db, [...MIGRATIONS]);
      for (let i = 0; i < 10; i++) {
        await expect(
          queueApprovalRequired(db, 'agent-a', 'file.write', { filePath: `f${i}` }),
        ).rejects.toBeInstanceOf(ApprovalRequiredError);
      }
      await expect(
        queueApprovalRequired(db, 'agent-a', 'file.write', { filePath: 'overflow' }),
      ).rejects.toBeInstanceOf(PermissionFloodError);
      const n = await db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM pending_approvals WHERE agent_id = 'agent-a'`,
      );
      expect(n.rows[0]?.n).toBe('10');
    },
    DB_TEST_TIMEOUT,
  );
});

describe('permission grants PGlite (GAP-294 §9)', () => {
  let db: PGlite;

  afterEach(async () => {
    await db?.close().catch(() => {});
  });

  it(
    'issues, covers consequential by class, exhausts maxUses, revokes',
    async () => {
      db = new PGlite();
      await migrate(db, [...MIGRATIONS]);

      await expect(
        issueGrant(db, {
          granteeAgentId: 'agent-a',
          classes: ['consequential'],
          issuedBy: 'agent-a',
        }),
      ).rejects.toThrow(/cannot issue a grant to itself/);

      await expect(
        issueGrant(db, {
          granteeAgentId: 'agent-a',
          classes: ['critical'],
          issuedBy: 'op-1',
        }),
      ).rejects.toThrow(/critical cannot be granted by class/);

      const grant = await issueGrant(db, {
        granteeAgentId: 'agent-a',
        classes: ['consequential'],
        methods: ['agent.spawn'],
        maxUses: 1,
        issuedBy: 'op-1',
      });
      expect(grant.status).toBe('active');
      expect(grant.usesRemaining).toBe(1);

      const hit = await tryConsumeGrant(db, 'agent-a', 'file.write', {
        filePath: '/tmp/x',
      });
      expect(hit?.grantId).toBe(grant.id);

      // maxUses=1 → exhausted; second consequential call needs another grant
      const miss = await tryConsumeGrant(db, 'agent-a', 'file.delete', {});
      expect(miss).toBe(null);

      const spawnGrant = await issueGrant(db, {
        granteeAgentId: 'agent-a',
        methods: ['agent.spawn'],
        issuedBy: 'op-1',
      });
      const spawnHit = await tryConsumeGrant(db, 'agent-a', 'agent.spawn', {});
      expect(spawnHit?.grantId).toBe(spawnGrant.id);

      // git.push not named → no cover
      expect(await tryConsumeGrant(db, 'agent-a', 'git.push', {})).toBe(null);

      await revokeGrant(db, spawnGrant.id, 'op-1');
      expect(await tryConsumeGrant(db, 'agent-a', 'agent.spawn', {})).toBe(null);

      const listed = await listGrants(db, 'agent-a', true);
      expect(listed.length).toBeGreaterThanOrEqual(2);
      expect(listed.some((g) => g.status === 'revoked')).toBe(true);
    },
    DB_TEST_TIMEOUT,
  );
});
