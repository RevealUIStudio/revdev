/**
 * Validation tests covering the schema/handler/bridge reconcile.
 *
 * Verifies each schema accepts the canonical payload shape that the
 * handler reads + the bridge sends. See GAP-173 for the audit context.
 */

import { describe, expect, it } from 'vitest';
import { validateParams } from '../validation/index.js';

describe('session.attach validation', () => {
  it('accepts canonical sessionId payload', () => {
    expect(validateParams('session.attach', { sessionId: 'agent-1' }).valid).toBe(true);
  });

  it('accepts agentId alias (compat)', () => {
    expect(validateParams('session.attach', { agentId: 'agent-1' }).valid).toBe(true);
  });

  it('accepts both sessionId and agentId together', () => {
    expect(
      validateParams('session.attach', { sessionId: 'agent-1', agentId: 'agent-1' }).valid,
    ).toBe(true);
  });

  it('rejects payload missing both sessionId and agentId', () => {
    const result = validateParams('session.attach', {});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('sessionId or agentId');
  });
});

describe('session.end validation', () => {
  it('accepts exitSummary (canonical)', () => {
    expect(validateParams('session.end', { exitSummary: 'done' }).valid).toBe(true);
  });

  it('accepts summary alias (compat)', () => {
    expect(validateParams('session.end', { summary: 'done' }).valid).toBe(true);
  });

  it('accepts sessionId override (admin cleanup)', () => {
    expect(validateParams('session.end', { sessionId: 'agent-1', exitSummary: 'done' }).valid).toBe(
      true,
    );
  });

  it('accepts agentId override alias', () => {
    expect(validateParams('session.end', { agentId: 'agent-1' }).valid).toBe(true);
  });

  it('accepts empty payload (ends caller session, no summary)', () => {
    expect(validateParams('session.end', {}).valid).toBe(true);
  });
});

describe('session.update validation', () => {
  it('accepts canonical task + files', () => {
    expect(validateParams('session.update', { task: 'work', files: 'a.ts' }).valid).toBe(true);
  });

  it('accepts sessionId/agentId for cross-session targeting', () => {
    expect(
      validateParams('session.update', {
        sessionId: 'agent-1',
        task: 'admin',
      }).valid,
    ).toBe(true);
  });
});

describe('session.list validation', () => {
  it('accepts default (no scope)', () => {
    expect(validateParams('session.list', {}).valid).toBe(true);
  });

  it("accepts scope='local'", () => {
    expect(validateParams('session.list', { scope: 'local' }).valid).toBe(true);
  });

  it("accepts scope='fleet'", () => {
    expect(validateParams('session.list', { scope: 'fleet' }).valid).toBe(true);
  });

  it('rejects invalid scope value', () => {
    expect(validateParams('session.list', { scope: 'galaxy' }).valid).toBe(false);
  });
});

describe('session.register validation', () => {
  it('accepts handler compat aliases (task, env, pid)', () => {
    expect(
      validateParams('session.register', {
        agentId: 'a',
        task: '/work',
        env: 'tmux:1',
        pid: 12345,
      }).valid,
    ).toBe(true);
  });

  it('rejects negative pid', () => {
    expect(validateParams('session.register', { pid: -1 }).valid).toBe(false);
  });
});

describe('mail.send validation', () => {
  it('accepts canonical to', () => {
    expect(validateParams('mail.send', { to: 'agent-2', subject: 's', body: 'b' }).valid).toBe(
      true,
    );
  });

  it('accepts toAgent alias (compat)', () => {
    expect(validateParams('mail.send', { toAgent: 'agent-2', subject: 's', body: 'b' }).valid).toBe(
      true,
    );
  });

  it('rejects payload missing both to and toAgent', () => {
    const result = validateParams('mail.send', { subject: 's', body: 'b' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('to or toAgent');
  });

  it('accepts priority enum', () => {
    expect(
      validateParams('mail.send', {
        to: 'a',
        subject: 's',
        body: 'b',
        priority: 'high',
      }).valid,
    ).toBe(true);
  });

  it('rejects invalid priority value', () => {
    expect(
      validateParams('mail.send', {
        to: 'a',
        subject: 's',
        body: 'b',
        priority: 'urgent',
      }).valid,
    ).toBe(false);
  });
});

describe('memory.store validation', () => {
  it('accepts canonical typed-record payload (memoryType + content)', () => {
    expect(
      validateParams('memory.store', {
        memoryType: 'fact',
        content: 'The sky is blue',
      }).valid,
    ).toBe(true);
  });

  it('accepts metadata as an object', () => {
    expect(
      validateParams('memory.store', {
        memoryType: 'preference',
        content: 'dark mode',
        metadata: { tags: ['ui', 'theme'] },
      }).valid,
    ).toBe(true);
  });

  it('rejects payload missing memoryType', () => {
    expect(validateParams('memory.store', { content: 'no type' }).valid).toBe(false);
  });

  it('rejects payload missing content', () => {
    expect(validateParams('memory.store', { memoryType: 'fact' }).valid).toBe(false);
  });

  it('rejects pre-#20 colloquial key/value/tags shape (no longer accepted)', () => {
    // The schema now requires memoryType + content; bare key/value won't satisfy.
    expect(
      validateParams('memory.store', {
        key: 'old-style',
        value: 'colloquial',
        tags: ['legacy'],
      }).valid,
    ).toBe(false);
  });
});

describe('memory.query validation', () => {
  it('accepts memoryType filter', () => {
    expect(validateParams('memory.query', { memoryType: 'fact' }).valid).toBe(true);
  });

  it('accepts query (full-text)', () => {
    expect(validateParams('memory.query', { query: 'sky' }).valid).toBe(true);
  });

  it('accepts tags filter', () => {
    expect(validateParams('memory.query', { tags: ['ui', 'theme'] }).valid).toBe(true);
  });

  it('accepts all filters together', () => {
    expect(
      validateParams('memory.query', {
        memoryType: 'preference',
        query: 'dark',
        tags: ['ui'],
        limit: 5,
      }).valid,
    ).toBe(true);
  });

  it('accepts empty payload (returns recent memories)', () => {
    expect(validateParams('memory.query', {}).valid).toBe(true);
  });
});

describe('tasks.create validation', () => {
  it('accepts canonical priority enum', () => {
    expect(
      validateParams('tasks.create', {
        title: 'Do thing',
        priority: 'high',
      }).valid,
    ).toBe(true);
  });

  it('accepts all 4 priority values', () => {
    for (const p of ['low', 'medium', 'high', 'critical']) {
      expect(validateParams('tasks.create', { title: 't', priority: p }).valid).toBe(true);
    }
  });

  it('rejects invalid priority value', () => {
    expect(validateParams('tasks.create', { title: 't', priority: 'urgent' }).valid).toBe(false);
  });

  it('accepts payload without priority (optional)', () => {
    expect(validateParams('tasks.create', { title: 't' }).valid).toBe(true);
  });
});

describe('tasks.complete validation', () => {
  it('accepts taskId + summary', () => {
    expect(validateParams('tasks.complete', { taskId: 't1', summary: 'done' }).valid).toBe(true);
  });

  it('rejects payload missing taskId', () => {
    expect(validateParams('tasks.complete', { summary: 'done' }).valid).toBe(false);
  });
});

describe('events.log validation', () => {
  it('accepts canonical eventType', () => {
    expect(validateParams('events.log', { eventType: 'agent.start', payload: {} }).valid).toBe(
      true,
    );
  });

  it('accepts agentId override (handler reads it)', () => {
    expect(
      validateParams('events.log', {
        eventType: 'admin.action',
        agentId: 'admin-1',
      }).valid,
    ).toBe(true);
  });
});

describe('worktree.remove validation', () => {
  it('accepts required branch', () => {
    expect(validateParams('worktree.remove', { branch: 'feat/x' }).valid).toBe(true);
  });

  it('rejects payload missing branch (handler throws otherwise)', () => {
    expect(validateParams('worktree.remove', {}).valid).toBe(false);
  });
});

describe('worktree.create validation', () => {
  it('accepts branch + baseBranch + path override', () => {
    expect(
      validateParams('worktree.create', {
        branch: 'feat/x',
        baseBranch: 'test',
        path: '/tmp/wt-feat-x',
      }).valid,
    ).toBe(true);
  });
});

describe('worktree.list validation', () => {
  it('accepts agentId filter', () => {
    expect(validateParams('worktree.list', { agentId: 'agent-1' }).valid).toBe(true);
  });

  it('accepts empty payload', () => {
    expect(validateParams('worktree.list', {}).valid).toBe(true);
  });
});

describe('merge.request validation', () => {
  it('accepts canonical sourceBranch', () => {
    expect(
      validateParams('merge.request', {
        sourceBranch: 'feat/x',
        baseBranch: 'main',
        description: 'd',
      }).valid,
    ).toBe(true);
  });

  it('accepts branch alias (compat — handler reads either)', () => {
    expect(validateParams('merge.request', { branch: 'feat/x', targetBranch: 'main' }).valid).toBe(
      true,
    );
  });

  it('rejects payload missing both sourceBranch and branch', () => {
    const result = validateParams('merge.request', { description: 'no branch' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('sourceBranch or branch');
  });
});

describe('merge.list validation', () => {
  it('accepts agentId filter', () => {
    expect(validateParams('merge.list', { agentId: 'agent-1' }).valid).toBe(true);
  });
});

describe('harness.health validation', () => {
  it('accepts empty payload', () => {
    expect(validateParams('harness.health', {}).valid).toBe(true);
  });

  it('accepts actorAgentId', () => {
    expect(validateParams('harness.health', { actorAgentId: 'agent-1' }).valid).toBe(true);
  });

  it('passes through extra fields (passthrough)', () => {
    expect(validateParams('harness.health', { extra: 'ignored' }).valid).toBe(true);
  });
});

describe('harness.prune validation', () => {
  it('accepts empty payload (handler defaults apply)', () => {
    expect(validateParams('harness.prune', {}).valid).toBe(true);
  });

  it('accepts integer staleDays + hardDeleteDays', () => {
    expect(validateParams('harness.prune', { staleDays: 7, hardDeleteDays: 30 }).valid).toBe(true);
  });

  it('accepts fractional days (test helpers use these to avoid long sleeps)', () => {
    expect(validateParams('harness.prune', { staleDays: 0.00001 }).valid).toBe(true);
  });

  it('accepts negative days (handler defensive clamp is the safety net)', () => {
    expect(validateParams('harness.prune', { staleDays: -1, hardDeleteDays: -7 }).valid).toBe(true);
  });

  it('rejects non-numeric staleDays', () => {
    const result = validateParams('harness.prune', { staleDays: 'forever' });
    expect(result.valid).toBe(false);
  });

  it('rejects non-numeric hardDeleteDays', () => {
    const result = validateParams('harness.prune', { hardDeleteDays: { days: 30 } });
    expect(result.valid).toBe(false);
  });
});

describe('inference.status validation', () => {
  it('accepts empty payload', () => {
    expect(validateParams('inference.status', {}).valid).toBe(true);
  });

  it('accepts actorAgentId', () => {
    expect(validateParams('inference.status', { actorAgentId: 'agent-1' }).valid).toBe(true);
  });
});

describe('git option-injection rejection (zero-9P)', () => {
  it('rejects a branch name starting with "-"', () => {
    expect(validateParams('git.switchBranch', { repoPath: '/r', name: '--orphan' }).valid).toBe(
      false,
    );
    expect(validateParams('git.createBranch', { repoPath: '/r', name: '-D' }).valid).toBe(false);
    expect(validateParams('git.deleteBranch', { repoPath: '/r', name: '--force' }).valid).toBe(
      false,
    );
  });

  it('rejects a push/pull remote starting with "-" (--receive-pack / --upload-pack)', () => {
    expect(
      validateParams('git.push', {
        repoPath: '/r',
        remote: '--receive-pack=touch /tmp/x',
        branch: 'main',
      }).valid,
    ).toBe(false);
    expect(validateParams('git.pull', { repoPath: '/r', remote: '--upload-pack=evil' }).valid).toBe(
      false,
    );
  });

  it('accepts ordinary branch and remote names', () => {
    expect(validateParams('git.switchBranch', { repoPath: '/r', name: 'feature/x' }).valid).toBe(
      true,
    );
    expect(
      validateParams('git.push', { repoPath: '/r', remote: 'origin', branch: 'main' }).valid,
    ).toBe(true);
  });
});

describe('No-schema methods (pass-through)', () => {
  it('ping passes through with empty payload', () => {
    expect(validateParams('ping', {}).valid).toBe(true);
  });

  it('unknown method passes through (schemas only validate known methods)', () => {
    expect(validateParams('not.a.method', { foo: 'bar' }).valid).toBe(true);
  });
});

describe('events.log payload DoS guard', () => {
  it('accepts a small JSON-serializable payload', () => {
    expect(validateParams('events.log', { eventType: 'note', payload: { ok: true } }).valid).toBe(
      true,
    );
  });

  it('accepts a missing (optional) payload', () => {
    expect(validateParams('events.log', { eventType: 'note' }).valid).toBe(true);
  });

  // The pre-fix refine called JSON.stringify, which throws on a BigInt — that
  // throw escaped safeParse and crashed the per-socket handler (pre-auth DoS).
  // It must now be rejected cleanly without throwing.
  it('rejects a BigInt payload without throwing (returns invalid)', () => {
    let result: ReturnType<typeof validateParams>;
    expect(() => {
      result = validateParams('events.log', { eventType: 'note', payload: { n: 1n } });
    }).not.toThrow();
    // biome-ignore lint/style/noNonNullAssertion: assigned in the callback above
    expect(result!.valid).toBe(false);
  });

  it('rejects a circular payload without throwing (returns invalid)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let result: ReturnType<typeof validateParams>;
    expect(() => {
      result = validateParams('events.log', { eventType: 'note', payload: circular });
    }).not.toThrow();
    // biome-ignore lint/style/noNonNullAssertion: assigned in the callback above
    expect(result!.valid).toBe(false);
  });

  it('rejects a non-JSON (function) payload without throwing', () => {
    // JSON.stringify returns undefined here, so the pre-fix `.length` also threw.
    expect(() =>
      validateParams('events.log', { eventType: 'note', payload: () => 'x' }),
    ).not.toThrow();
    expect(validateParams('events.log', { eventType: 'note', payload: () => 'x' }).valid).toBe(
      false,
    );
  });

  it('rejects an oversize payload', () => {
    const huge = 'x'.repeat(200_000);
    const result = validateParams('events.log', { eventType: 'note', payload: huge });
    expect(result.valid).toBe(false);
  });
});
