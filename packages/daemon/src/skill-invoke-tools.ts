/**
 * GAP-293 Phase C tool execution for skills.invoke.
 * Tool-guard + path prefixes. No commits. Output capped.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { enforceSkillTool, type SkillPermissionCtx, type SkillToolName } from './permission.js';
import {
  isNativeWorkflowToolName,
  type NativeWorkflowToolName,
  type SkillInvokeToolCall,
} from './skill-invoke.js';
import { evaluateToolAction, evaluateToolActionAsync } from './tool-guard/index.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 32_768;
const CMD_TIMEOUT_MS = 30_000;

export interface SkillToolContext {
  projectRoot: string;
  revskillsRoot?: string;
  permission?: SkillPermissionCtx;
}

export interface SkillToolResult {
  name: string;
  ok: boolean;
  text: string;
}

function expandUserPath(raw: string): string {
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return raw;
}

function isUnder(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(prefix);
}

function allowedRoots(ctx: SkillToolContext): string[] {
  const home = homedir();
  const roots = [
    resolve(ctx.projectRoot),
    resolve(home, 'revfleet'),
    resolve(home, '.claude'),
    resolve(home, '.grok'),
    resolve(home, '.cursor'),
  ];
  if (ctx.revskillsRoot && ctx.revskillsRoot.length > 0) {
    roots.push(resolve(ctx.revskillsRoot));
  }
  return roots;
}

function resolveToolPath(
  raw: string | undefined,
  ctx: SkillToolContext,
): string | { error: string } {
  const input = (raw ?? '').trim();
  if (input.length === 0) return { error: 'path is required' };
  const expanded = expandUserPath(input);
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(ctx.projectRoot, expanded);
  if (!allowedRoots(ctx).some((root) => isUnder(root, abs))) {
    return { error: `path not in allowed skill roots: ${abs}` };
  }
  return abs;
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n… truncated`;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

async function runRead(
  args: Record<string, unknown>,
  ctx: SkillToolContext,
): Promise<SkillToolResult> {
  const resolved = resolveToolPath(asString(args.path), ctx);
  if (typeof resolved !== 'string') return { name: 'Read', ok: false, text: resolved.error };
  const verdict = evaluateToolAction({ kind: 'read', path: resolved });
  if (!verdict.allowed) {
    return { name: 'Read', ok: false, text: verdict.reason ?? 'read blocked' };
  }
  try {
    const buf = await readFile(resolved);
    return { name: 'Read', ok: true, text: clip(buf.toString('utf8')) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Read', ok: false, text: msg };
  }
}

async function runRg(
  name: NativeWorkflowToolName,
  rgArgs: string[],
  cwd: string,
): Promise<SkillToolResult> {
  try {
    const { stdout, stderr } = await execFileAsync('rg', rgArgs, {
      cwd,
      timeout: CMD_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
    });
    const text = clip(`${stdout}${stderr}`);
    return { name, ok: true, text: text.length > 0 ? text : '(no matches)' };
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    if (execErr.code === 1) {
      return { name, ok: true, text: '(no matches)' };
    }
    return {
      name,
      ok: false,
      text: clip(execErr.stderr ?? execErr.message ?? String(err)),
    };
  }
}

async function runGrep(
  args: Record<string, unknown>,
  ctx: SkillToolContext,
): Promise<SkillToolResult> {
  const pattern = asString(args.pattern);
  if (!pattern) return { name: 'Grep', ok: false, text: 'pattern is required' };
  const resolved = resolveToolPath(asString(args.path) ?? ctx.projectRoot, ctx);
  if (typeof resolved !== 'string') return { name: 'Grep', ok: false, text: resolved.error };
  const verdict = evaluateToolAction({ kind: 'read', path: resolved });
  if (!verdict.allowed) {
    return { name: 'Grep', ok: false, text: verdict.reason ?? 'grep blocked' };
  }
  return runRg('Grep', ['-n', '--max-count', '50', '--', pattern, resolved], ctx.projectRoot);
}

async function runGlob(
  args: Record<string, unknown>,
  ctx: SkillToolContext,
): Promise<SkillToolResult> {
  const pattern = asString(args.pattern);
  if (!pattern) return { name: 'Glob', ok: false, text: 'pattern is required' };
  const resolved = resolveToolPath(asString(args.path) ?? ctx.projectRoot, ctx);
  if (typeof resolved !== 'string') return { name: 'Glob', ok: false, text: resolved.error };
  const verdict = evaluateToolAction({ kind: 'read', path: resolved });
  if (!verdict.allowed) {
    return { name: 'Glob', ok: false, text: verdict.reason ?? 'glob blocked' };
  }
  return runRg('Glob', ['--files', '-g', pattern, resolved], ctx.projectRoot);
}

async function runBash(
  args: Record<string, unknown>,
  ctx: SkillToolContext,
): Promise<SkillToolResult> {
  const command = asString(args.command);
  if (!command) return { name: 'Bash', ok: false, text: 'command is required' };
  const verdict = await evaluateToolActionAsync({ kind: 'command', command });
  if (!verdict.allowed) {
    return { name: 'Bash', ok: false, text: verdict.reason ?? 'command blocked' };
  }
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-lc', command], {
      cwd: ctx.projectRoot,
      timeout: CMD_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
    });
    return { name: 'Bash', ok: true, text: clip(`${stdout}${stderr}`.trim() || '(empty)') };
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    return {
      name: 'Bash',
      ok: false,
      text: clip((execErr.stderr ?? execErr.stdout ?? execErr.message ?? String(err)).trim()),
    };
  }
}

export async function executeSkillInvokeTool(
  call: SkillInvokeToolCall,
  allowed: readonly NativeWorkflowToolName[],
  ctx: SkillToolContext,
): Promise<SkillToolResult> {
  if (!isNativeWorkflowToolName(call.name) || !allowed.includes(call.name)) {
    return { name: call.name, ok: false, text: `tool ${call.name} is not on this skill allowlist` };
  }
  const args = parseArgs(call.arguments);
  await enforceSkillTool(call.name as SkillToolName, args, ctx.permission);
  if (call.name === 'Read') return runRead(args, ctx);
  if (call.name === 'Grep') return runGrep(args, ctx);
  if (call.name === 'Glob') return runGlob(args, ctx);
  return runBash(args, ctx);
}
