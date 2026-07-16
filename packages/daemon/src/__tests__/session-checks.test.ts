/**
 * Session-check registry + runner + doc-locations check unit tests.
 *
 * Covers the surface's invariants directly (no socket):
 *   - a passing check contributes no warnings
 *   - a warning check surfaces its warnings
 *   - a throwing check is skipped and never aborts the run
 *   - the doc-locations check flags a configured violation and passes clean
 *
 * @vitest-environment node
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSessionChecks,
  createDocLocationsCheck,
  registeredSessionCheckNames,
  registerSessionCheck,
  runSessionChecks,
} from '../session-checks/index.js';

const CTX = { workDir: '/tmp/does-not-matter', agentId: 'agent-test' };

describe('session-check registry + runner', () => {
  beforeEach(() => clearSessionChecks());
  afterEach(() => clearSessionChecks());

  it('a passing check contributes no warnings', async () => {
    registerSessionCheck('pass', async () => ({ ok: true, warnings: [] }));
    const warnings = await runSessionChecks(CTX);
    expect(warnings).toEqual([]);
  });

  it('a warning check surfaces its warnings', async () => {
    registerSessionCheck('warn', async () => ({
      ok: false,
      warnings: ['drift: X is misplaced'],
    }));
    const warnings = await runSessionChecks(CTX);
    expect(warnings).toEqual(['drift: X is misplaced']);
  });

  it('a throwing check is skipped and never aborts the run', async () => {
    registerSessionCheck('boom', async () => {
      throw new Error('check exploded');
    });
    registerSessionCheck('warn', async () => ({ ok: false, warnings: ['still reported'] }));

    // Must resolve (not reject) and still return the healthy check's warning.
    const warnings = await runSessionChecks(CTX);
    expect(warnings).toEqual(['still reported']);
  });

  it('collects warnings across multiple checks', async () => {
    registerSessionCheck('a', async () => ({ ok: false, warnings: ['a1'] }));
    registerSessionCheck('b', async () => ({ ok: false, warnings: ['b1', 'b2'] }));
    const warnings = await runSessionChecks(CTX);
    expect(warnings).toEqual(['a1', 'b1', 'b2']);
  });

  it('re-registering a name overwrites the prior check', () => {
    registerSessionCheck('dup', async () => ({ ok: true, warnings: [] }));
    registerSessionCheck('dup', async () => ({ ok: true, warnings: [] }));
    expect(registeredSessionCheckNames()).toEqual(['dup']);
  });
});

describe('doc-locations check', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'revdev-doc-loc-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('empty config is a no-op', async () => {
    const check = createDocLocationsCheck({});
    const result = await check({ workDir: root, agentId: 'a' });
    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it('missing workDir returns clean', async () => {
    const check = createDocLocationsCheck({
      restrictedDirs: [{ dir: 'docs/handoffs', allowedFiles: ['README.md'] }],
    });
    const result = await check({ workDir: '', agentId: 'a' });
    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it('flags a misplaced file in a restricted directory', async () => {
    await mkdir(join(root, 'docs', 'handoffs'), { recursive: true });
    await writeFile(join(root, 'docs', 'handoffs', 'README.md'), '# ok');
    await writeFile(join(root, 'docs', 'handoffs', 'STRAY.md'), '# drift');

    const check = createDocLocationsCheck({
      restrictedDirs: [
        {
          dir: 'docs/handoffs',
          allowedFiles: ['README.md'],
          allowedSubdirs: ['archive'],
          hint: 'active handoffs belong at docs root',
        },
      ],
    });
    const result = await check({ workDir: root, agentId: 'a' });
    expect(result.ok).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('docs/handoffs/STRAY.md');
    expect(result.warnings[0]).toContain('active handoffs belong at docs root');
  });

  it('flags an unexpected subdirectory in a restricted directory', async () => {
    await mkdir(join(root, 'docs', 'handoffs', 'archive'), { recursive: true });
    await mkdir(join(root, 'docs', 'handoffs', 'weird'), { recursive: true });

    const check = createDocLocationsCheck({
      restrictedDirs: [
        { dir: 'docs/handoffs', allowedFiles: ['README.md'], allowedSubdirs: ['archive'] },
      ],
    });
    const result = await check({ workDir: root, agentId: 'a' });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("'docs/handoffs/weird/'");
  });

  it('flags a subdirectory missing its required file', async () => {
    await mkdir(join(root, 'docs', 'lanes', 'with-plan'), { recursive: true });
    await writeFile(join(root, 'docs', 'lanes', 'with-plan', 'plan.md'), '# lane');
    await mkdir(join(root, 'docs', 'lanes', 'no-plan'), { recursive: true });

    const check = createDocLocationsCheck({
      requiredFileInSubdirs: [
        { parentDir: 'docs/lanes', requiredFile: 'plan.md', ignoreSubdirs: ['_closed'] },
      ],
    });
    const result = await check({ workDir: root, agentId: 'a' });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("'docs/lanes/no-plan' is missing required file 'plan.md'");
  });

  it('passes a clean tree', async () => {
    await mkdir(join(root, 'docs', 'handoffs', 'archive'), { recursive: true });
    await writeFile(join(root, 'docs', 'handoffs', 'README.md'), '# ok');
    await mkdir(join(root, 'docs', 'lanes', 'good'), { recursive: true });
    await writeFile(join(root, 'docs', 'lanes', 'good', 'plan.md'), '# lane');

    const check = createDocLocationsCheck({
      restrictedDirs: [
        { dir: 'docs/handoffs', allowedFiles: ['README.md'], allowedSubdirs: ['archive'] },
      ],
      requiredFileInSubdirs: [{ parentDir: 'docs/lanes', requiredFile: 'plan.md' }],
    });
    const result = await check({ workDir: root, agentId: 'a' });
    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it('is a no-op when the configured directories do not exist', async () => {
    const check = createDocLocationsCheck({
      restrictedDirs: [{ dir: 'docs/handoffs', allowedFiles: ['README.md'] }],
      requiredFileInSubdirs: [{ parentDir: 'docs/lanes', requiredFile: 'plan.md' }],
    });
    const result = await check({ workDir: root, agentId: 'a' });
    expect(result).toEqual({ ok: true, warnings: [] });
  });
});
