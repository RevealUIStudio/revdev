/**
 * dup-work-claim check unit tests.
 *
 * Covers the check's invariants:
 *   - two worktrees claiming the same configured marker -> a warning
 *   - distinct markers -> clean
 *   - unconfigured (no markers) -> no-op, and git is never spawned
 *   - a git failure (non-zero exit OR a throwing lister) -> clean, never throws
 *
 * The warning-path tests drive the REAL default lister (hardened `runGit`)
 * against a throwaway git repo with linked worktrees, so the porcelain parse +
 * extraction are exercised end to end. The edge cases inject a lister so no git
 * is spawned and the failure paths are deterministic.
 *
 * @vitest-environment node
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDupWorkClaimCheck } from '../session-checks/index.js';
import type { ShellResult } from '../vcs.js';

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const CTX_AGENT = 'agent-test';

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

describe('dup-work-claim check (real git worktrees)', () => {
  let base: string;
  let repo: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'revdev-dup-work-'));
    repo = join(base, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, ['init', '-q']);
    await writeFile(join(repo, 'README.md'), '# seed');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'seed']);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('warns when the same marker is claimed by two worktrees', async () => {
    git(repo, [
      'worktree',
      'add',
      '-q',
      '-b',
      'feat/task-42-alpha',
      join(base, 'wt-TASK-42-alpha'),
    ]);
    git(repo, ['worktree', 'add', '-q', '-b', 'feat/task-42-beta', join(base, 'wt-TASK-42-beta')]);

    const check = createDupWorkClaimCheck({ claimMarkers: ['TASK-'] });
    const result = await check({ workDir: repo, agentId: CTX_AGENT });

    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("'task-42' is claimed by 2 worktrees");
    expect(result.warnings[0]).toContain('wt-TASK-42-alpha');
    expect(result.warnings[0]).toContain('wt-TASK-42-beta');
  });

  it('is clean when worktrees carry distinct markers', async () => {
    git(repo, ['worktree', 'add', '-q', '-b', 'feat/task-42', join(base, 'wt-TASK-42')]);
    git(repo, ['worktree', 'add', '-q', '-b', 'feat/task-99', join(base, 'wt-TASK-99')]);

    const check = createDupWorkClaimCheck({ claimMarkers: ['TASK-'] });
    const result = await check({ workDir: repo, agentId: CTX_AGENT });

    expect(result).toEqual({ ok: true, warnings: [] });
  });
});

describe('dup-work-claim check (injected lister)', () => {
  const okResult = (stdout: string): ShellResult => ({ ok: true, stdout, stderr: '', code: 0 });

  it('is a no-op when no markers are configured, and never spawns git', async () => {
    let called = false;
    const lister = async (): Promise<ShellResult> => {
      called = true;
      return okResult('');
    };
    const check = createDupWorkClaimCheck({}, lister);
    const result = await check({ workDir: '/tmp/project', agentId: CTX_AGENT });

    expect(result).toEqual({ ok: true, warnings: [] });
    expect(called).toBe(false);
  });

  it('is a no-op when workDir is empty', async () => {
    let called = false;
    const lister = async (): Promise<ShellResult> => {
      called = true;
      return okResult('');
    };
    const check = createDupWorkClaimCheck({ claimMarkers: ['TASK-'] }, lister);
    const result = await check({ workDir: '', agentId: CTX_AGENT });

    expect(result).toEqual({ ok: true, warnings: [] });
    expect(called).toBe(false);
  });

  it('returns clean (no throw) when the git lister exits non-zero', async () => {
    const lister = async (): Promise<ShellResult> => ({
      ok: false,
      stdout: '',
      stderr: 'fatal: not a git repository',
      code: 128,
    });
    const check = createDupWorkClaimCheck({ claimMarkers: ['TASK-'] }, lister);
    const result = await check({ workDir: '/tmp/not-a-repo', agentId: CTX_AGENT });

    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it('returns clean (no throw) when the git lister throws', async () => {
    const lister = async (): Promise<ShellResult> => {
      throw new Error('spawn git ENOENT');
    };
    const check = createDupWorkClaimCheck({ claimMarkers: ['TASK-'] }, lister);
    await expect(check({ workDir: '/tmp/project', agentId: CTX_AGENT })).resolves.toEqual({
      ok: true,
      warnings: [],
    });
  });

  it('extracts claims from branch names as well as paths', async () => {
    // The path basename omits the marker; only the branch carries it.
    const porcelain = [
      'worktree /home/dev/project',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /home/dev/alpha',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feat/gap-7-x',
      '',
      'worktree /home/dev/beta',
      'HEAD 3333333333333333333333333333333333333333',
      'branch refs/heads/fix/gap-7-y',
      '',
    ].join('\n');
    const check = createDupWorkClaimCheck({ claimMarkers: ['GAP-'] }, async () =>
      okResult(porcelain),
    );
    const result = await check({ workDir: '/home/dev/project', agentId: CTX_AGENT });

    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("'gap-7' is claimed by 2 worktrees");
    expect(result.warnings[0]).toContain('/home/dev/alpha');
    expect(result.warnings[0]).toContain('/home/dev/beta');
  });
});
