/**
 * GAP-293 Phase C — native workflow allowlist + prompt bind.
 * Snap: product default `gemma3` (US-origin catalog SSOT).
 */

import { readFileSync } from 'node:fs';
import type { SkillCatalogEntry } from './skill-catalog.js';

export const NATIVE_WORKFLOW_SKILL_IDS = [
  'revealui-doctor',
  'revealui-recover',
  'revealui-checkpoint',
] as const;

export const PHASE_C_INFERENCE_SNAP = 'gemma3';

const ALIASES: Record<string, (typeof NATIVE_WORKFLOW_SKILL_IDS)[number]> = {
  doctor: 'revealui-doctor',
  recover: 'revealui-recover',
  checkpoint: 'revealui-checkpoint',
};

export function resolveNativeWorkflowSkillId(
  raw: string,
): (typeof NATIVE_WORKFLOW_SKILL_IDS)[number] | null {
  const key = raw.trim();
  if (key in ALIASES) return ALIASES[key] ?? null;
  for (const id of NATIVE_WORKFLOW_SKILL_IDS) {
    if (id === key) return id;
  }
  return null;
}

export const NATIVE_WORKFLOW_TOOL_NAMES = ['Read', 'Grep', 'Glob', 'Bash'] as const;
export type NativeWorkflowToolName = (typeof NATIVE_WORKFLOW_TOOL_NAMES)[number];
export const SKILL_INVOKE_MAX_TOOL_ROUNDS = 6;

export function isNativeWorkflowToolName(name: string): name is NativeWorkflowToolName {
  return (NATIVE_WORKFLOW_TOOL_NAMES as readonly string[]).includes(name);
}

export function parseNativeWorkflowTools(raw: readonly string[]): NativeWorkflowToolName[] {
  const out: NativeWorkflowToolName[] = [];
  for (const name of raw) {
    if (isNativeWorkflowToolName(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

function parseAllowedToolsFromSkillBody(body: string): NativeWorkflowToolName[] {
  const lines = body.split('\n');
  let inFm = false;
  for (const line of lines) {
    if (line === '---') {
      if (!inFm) {
        inFm = true;
        continue;
      }
      break;
    }
    if (!inFm) break;
    if (!line.startsWith('allowed-tools:')) continue;
    const raw = line.slice(14).trim();
    return parseNativeWorkflowTools(
      raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    );
  }
  return [];
}

export function prepareInvoke(
  skillId: string,
  catalog: SkillCatalogEntry[],
):
  | {
      skillId: string;
      model: string;
      path: string;
      system: string;
      user: string;
      allowedTools: NativeWorkflowToolName[];
    }
  | { error: string } {
  const resolved = resolveNativeWorkflowSkillId(skillId);
  if (!resolved) {
    return {
      error: `skills.invoke allowlist is ${NATIVE_WORKFLOW_SKILL_IDS.join(', ')} (or doctor/recover/checkpoint). Got: ${skillId}`,
    };
  }
  const entry = catalog.find((s) => s.id === resolved);
  if (!entry) {
    return {
      error: `skill ${resolved} is not in the catalog (materialize content or set REVDEV_REVSKILLS_ROOT)`,
    };
  }
  let body: string;
  try {
    body = readFileSync(entry.path, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `cannot read ${entry.path}: ${msg}` };
  }
  const allowedTools = parseAllowedToolsFromSkillBody(body);
  const toolClause =
    allowedTools.length > 0
      ? `Use the provided tools (${allowedTools.join(', ')}) to gather facts. Do not invent file contents or command output. Do not commit or push.`
      : 'You cannot execute tools or git commits from this invoke. Name any command you would have run; do not claim you ran it.';
  return {
    skillId: resolved,
    model: PHASE_C_INFERENCE_SNAP,
    path: entry.path,
    system: body,
    user: [
      `Run the ${resolved} workflow as a RevDev-native pass.`,
      `Local model is the product default Inference Snap: ${PHASE_C_INFERENCE_SNAP}.`,
      toolClause,
      'Produce the structured report the skill specifies.',
    ].join(' '),
    allowedTools,
  };
}

/** OpenAI-compat text. nemotron-3-nano fills reasoning_content, not content. */
export function extractSkillInvokeText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (!first || typeof first !== 'object') return '';
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return '';
  const rec = message as { content?: unknown; reasoning_content?: unknown };
  const content = typeof rec.content === 'string' ? rec.content.trim() : '';
  if (content.length > 0) return rec.content as string;
  const reasoning = typeof rec.reasoning_content === 'string' ? rec.reasoning_content.trim() : '';
  if (reasoning.length > 0) return rec.reasoning_content as string;
  return '';
}

export const SKILL_INVOKE_MS_PER_PROMPT_TOKEN = 1_200;
export const SKILL_INVOKE_DECODE_BUDGET_MS = 180_000;
export const SKILL_INVOKE_MIN_TIMEOUT_MS = 300_000;
export const SKILL_INVOKE_MAX_TIMEOUT_MS = 14_400_000;

/**
 * Hard cap on completion tokens. Unbounded decode lets a 270m CPU snap
 * ramble until the wall-clock budget (minutes) while the client is gone.
 * 2048 is enough for a Phase C traffic-light / diagnostic / checkpoint report.
 */
export const SKILL_INVOKE_MAX_COMPLETION_TOKENS = 2_048;

export interface SkillInvokeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export function extractSkillInvokeToolCalls(payload: unknown): SkillInvokeToolCall[] {
  if (!payload || typeof payload !== 'object') return [];
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const first = choices[0];
  if (!first || typeof first !== 'object') return [];
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return [];
  const raw = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(raw)) return [];
  const out: SkillInvokeToolCall[] = [];
  for (const call of raw) {
    if (!call || typeof call !== 'object') continue;
    const rec = call as { id?: unknown; function?: unknown };
    const fn = rec.function;
    if (!fn || typeof fn !== 'object') continue;
    const name = (fn as { name?: unknown }).name;
    const args = (fn as { arguments?: unknown }).arguments;
    if (typeof name !== 'string' || name.trim() === '') continue;
    out.push({
      id: typeof rec.id === 'string' && rec.id.length > 0 ? rec.id : `call_${String(out.length)}`,
      name,
      arguments: typeof args === 'string' ? args : '{}',
    });
  }
  return out;
}

export interface SkillInvokeToolDefinition {
  type: 'function';
  function: {
    name: NativeWorkflowToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const TOOL_DEFS: Record<NativeWorkflowToolName, SkillInvokeToolDefinition> = {
  Read: {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a UTF-8 file. Path must be absolute or project-relative.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  Grep: {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search file contents with ripgrep.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' }, path: { type: 'string' } },
        required: ['pattern'],
      },
    },
  },
  Glob: {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'List files matching a glob under a directory.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' }, path: { type: 'string' } },
        required: ['pattern'],
      },
    },
  },
  Bash: {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Run a shell command. No commits, no pushes, no secret prints.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
};

export function nativeWorkflowToolDefinitions(
  allowed: readonly NativeWorkflowToolName[],
): SkillInvokeToolDefinition[] {
  return allowed.map((name) => TOOL_DEFS[name]);
}

export type SkillInvokeMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: SkillInvokeToolCall[];
};

export interface SkillInvokeCompletionBody {
  model: typeof PHASE_C_INFERENCE_SNAP;
  messages: SkillInvokeMessage[];
  max_tokens: typeof SKILL_INVOKE_MAX_COMPLETION_TOKENS;
  stream: false;
  tools?: SkillInvokeToolDefinition[];
  tool_choice?: 'auto';
}

/** OpenAI-compat POST body for skills.invoke. Always bounded. */
export function skillInvokeCompletionBody(
  messages: SkillInvokeMessage[],
  tools: readonly NativeWorkflowToolName[] = [],
): SkillInvokeCompletionBody {
  const defs = nativeWorkflowToolDefinitions([...tools]);
  const body: SkillInvokeCompletionBody = {
    model: PHASE_C_INFERENCE_SNAP,
    messages,
    max_tokens: SKILL_INVOKE_MAX_COMPLETION_TOKENS,
    stream: false,
  };
  if (defs.length > 0) {
    body.tools = defs;
    body.tool_choice = 'auto';
  }
  return body;
}

export function parseSkillInvokeTimeoutOverride(raw: string | undefined): number | null {
  if (!raw || raw.trim().length === 0) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function skillInvokeTimeoutMs(
  system: string,
  user: string,
  overrideMs?: number | null,
): number {
  if (overrideMs !== undefined && overrideMs !== null && overrideMs > 0) return overrideMs;
  const approxTokens = Math.max(1, Math.ceil((system.length + user.length) / 4));
  const sized = approxTokens * SKILL_INVOKE_MS_PER_PROMPT_TOKEN + SKILL_INVOKE_DECODE_BUDGET_MS;
  return Math.min(SKILL_INVOKE_MAX_TIMEOUT_MS, Math.max(SKILL_INVOKE_MIN_TIMEOUT_MS, sized));
}

export type SkillInvokeFailureKind = 'timeout' | 'connect' | 'other';

const TIMEOUT_NAMES = new Set([
  'TimeoutError',
  'AbortError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
  'ConnectTimeoutError',
]);

const TIMEOUT_CODES = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function walkErrorChain(err: unknown, visit: (e: Error) => boolean): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      if (visit(current)) return true;
      current = current.cause;
      continue;
    }
    break;
  }
  return false;
}

/** Undici wraps 300s header timeouts as TypeError: fetch failed + cause. */
export function isSkillInvokeTimeoutError(err: unknown): boolean {
  return walkErrorChain(err, (e) => {
    if (TIMEOUT_NAMES.has(e.name)) return true;
    const code = (e as Error & { code?: string }).code;
    if (code && TIMEOUT_CODES.has(code)) return true;
    return /aborted due to timeout|The operation was aborted|Headers Timeout|Body Timeout/i.test(
      e.message,
    );
  });
}

export function classifySkillInvokeFailure(err: unknown): SkillInvokeFailureKind {
  if (isSkillInvokeTimeoutError(err)) return 'timeout';
  if (!(err instanceof Error)) return 'other';
  const msg = err.message;
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|Failed to parse URL/i.test(msg)) {
    return 'connect';
  }
  return 'other';
}
