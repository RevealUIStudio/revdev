/**
 * GAP-473 — workflow.list / workflow.run unit tests.
 * Uses a scratch registry so tests never touch the real ~/revfleet/.jv tree.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkflows, runWorkflow } from '../workflow-rpc.js';

function writeMinimalRunner(jvRoot: string): void {
  const scripts = join(jvRoot, 'scripts');
  mkdirSync(scripts, { recursive: true });
  // Minimal runner: --list prints fixed lines; <name> exits 0 unless gated without --fix
  writeFileSync(
    join(scripts, 'workflow-run.js'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--list')) {
  console.log('workflow-run: registry at test');
  console.log('  prepare-for-exit — Verify clean [safety: auto]');
  process.exit(0);
}
const name = args.find((a) => a[0] !== '-');
const fix = args.includes('--fix') || args.includes('--yes');
const dry = args.includes('--dry-run');
if (name === 'cleanup-session' && !fix && !dry) {
  console.log('[STOPPED-GATED] cleanup');
  process.exit(1);
}
if (name === 'missing-will-not-be-called') {
  process.exit(2);
}
console.log('RUN — ' + name + (dry ? ' dry' : ''));
process.exit(0);
`,
  );
}

function writeWorkflow(jvRoot: string, name: string, safety: string): void {
  const dir = join(jvRoot, 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.yml`),
    `name: ${name}
title: Test ${name}
safety: ${safety}
steps:
  - id: s1
    title: step
    run: node -e "process.exit(0)"
    safety: ${safety}
`,
  );
}

describe('workflow-rpc (GAP-473)', () => {
  const roots: string[] = [];
  afterEach(() => {
    // leave tmpdirs for OS cleanup; no recursive rm (policy)
    roots.length = 0;
  });

  function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), 'revdev-wf-'));
    roots.push(root);
    writeMinimalRunner(root);
    writeWorkflow(root, 'prepare-for-exit', 'auto');
    writeWorkflow(root, 'cleanup-session', 'gated');
    return root;
  }

  it('listWorkflows returns registry entries', () => {
    const root = scratch();
    const list = listWorkflows(root);
    expect(list.length).toBe(2);
    expect(list.map((w) => w.name).sort()).toEqual(['cleanup-session', 'prepare-for-exit']);
    expect(list.find((w) => w.name === 'prepare-for-exit')?.safety).toBe('auto');
  });

  it('listWorkflows throws when registry missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'revdev-wf-empty-'));
    expect(() => listWorkflows(root)).toThrow(/workflow runner missing|registry missing/);
  });

  it('runWorkflow prepare-for-exit succeeds', () => {
    const root = scratch();
    const r = runWorkflow(root, 'prepare-for-exit', {});
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('prepare-for-exit');
  });

  it('runWorkflow cleanup-session without fix exits non-zero (gated)', () => {
    const root = scratch();
    const r = runWorkflow(root, 'cleanup-session', {});
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain('STOPPED-GATED');
  });

  it('runWorkflow cleanup-session with fix succeeds', () => {
    const root = scratch();
    const r = runWorkflow(root, 'cleanup-session', { fix: true });
    expect(r.exitCode).toBe(0);
  });

  it('runWorkflow rejects path-shaped names', () => {
    const root = scratch();
    expect(() => runWorkflow(root, '../evil', {})).toThrow(/invalid name/);
  });
});
