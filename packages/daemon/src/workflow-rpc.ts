/**
 * GAP-474 — workflow.list / workflow.run
 *
 * Thin daemon surface over the Studio operational-workflow registry
 * (`workflows/*.yml` + `scripts/workflow-run.js` under `REVDEV_JV_ROOT`,
 * defaulting to the private planning checkout beside this monorepo).
 * No second schema: list/run shell the same runner Studio `/ops` uses.
 *
 * Safety classes stay enforced inside workflow-run.js:
 *   auto | report-first | gated | owner-only
 * Gated steps need `fix: true` (or `yes: true`); owner-only is never executed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerHandler } from './server.js';

const RUNNER_TIMEOUT_MS = 5 * 60 * 1000;
const RUNNER_MAX_BUFFER = 10 * 1024 * 1024;

export interface WorkflowListEntry {
  name: string;
  title: string;
  safety: string;
  file: string;
}

function resolveJvRoot(params: Record<string, unknown> | undefined): string {
  if (params && typeof params.jvRoot === 'string' && params.jvRoot.length > 0) {
    return params.jvRoot;
  }
  if (process.env.REVDEV_JV_ROOT && process.env.REVDEV_JV_ROOT.length > 0) {
    return process.env.REVDEV_JV_ROOT;
  }
  // Default layout: <home>/revfleet/<private planning root> (not a public path claim).
  return join(homedir(), 'revfleet', '.jv');
}

function runnerPath(jvRoot: string): string {
  return join(jvRoot, 'scripts', 'workflow-run.js');
}

function assertRegistry(jvRoot: string): void {
  const runner = runnerPath(jvRoot);
  const dir = join(jvRoot, 'workflows');
  if (!existsSync(runner)) {
    throw new Error(
      `workflow runner missing at ${runner} (set REVDEV_JV_ROOT or install .jv checkout)`,
    );
  }
  if (!existsSync(dir)) {
    throw new Error(`workflow registry missing at ${dir}`);
  }
}

/** Minimal YAML field skim (name/title/safety) — list only; run uses the runner. */
function skimYamlFields(text: string): { name: string; title: string; safety: string } {
  let name = '';
  let title = '';
  let safety = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('name:')) name = line.slice(5).trim();
    else if (line.startsWith('title:')) title = line.slice(6).trim();
    else if (line.startsWith('safety:') && safety === '') safety = line.slice(7).trim();
  }
  return { name, title, safety };
}

export function listWorkflows(jvRoot: string): WorkflowListEntry[] {
  assertRegistry(jvRoot);
  const dir = join(jvRoot, 'workflows');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
  const out: WorkflowListEntry[] = [];
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    const fields = skimYamlFields(text);
    out.push({
      name: fields.name || file.replace(/\.ya?ml$/, ''),
      title: fields.title,
      safety: fields.safety,
      file,
    });
  }
  return out;
}

export interface WorkflowRunResult {
  name: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  dryRun: boolean;
  fix: boolean;
}

export function runWorkflow(
  jvRoot: string,
  name: string,
  opts: { dryRun?: boolean; fix?: boolean; yes?: boolean },
): WorkflowRunResult {
  assertRegistry(jvRoot);
  if (!name || typeof name !== 'string') {
    throw new Error('workflow.run requires params.name (workflow id)');
  }
  // Refuse path-shaped names (no second registry, no arbitrary exec)
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`workflow.run: invalid name ${JSON.stringify(name)}`);
  }

  const args = [runnerPath(jvRoot), name, '--root', jvRoot];
  if (opts.dryRun) args.push('--dry-run');
  if (opts.fix) args.push('--fix');
  if (opts.yes) args.push('--yes');

  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: RUNNER_TIMEOUT_MS,
    maxBuffer: RUNNER_MAX_BUFFER,
  });

  if (r.error) {
    throw new Error(`workflow.run spawn failed: ${r.error.message}`);
  }

  return {
    name,
    exitCode: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    dryRun: Boolean(opts.dryRun),
    fix: Boolean(opts.fix || opts.yes),
  };
}

registerHandler('workflow.list', async (params) => {
  const p = (params ?? {}) as Record<string, unknown>;
  const jvRoot = resolveJvRoot(p);
  const workflows = listWorkflows(jvRoot);
  return { jvRoot, workflows, count: workflows.length };
});

registerHandler('workflow.run', async (params) => {
  const p = (params ?? {}) as Record<string, unknown>;
  const jvRoot = resolveJvRoot(p);
  const name = typeof p.name === 'string' ? p.name : '';
  const dryRun = p.dryRun === true || p['dry-run'] === true;
  const fix = p.fix === true;
  const yes = p.yes === true;
  return runWorkflow(jvRoot, name, { dryRun, fix, yes });
});
