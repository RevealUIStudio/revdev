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

export function prepareInvoke(
  skillId: string,
  catalog: SkillCatalogEntry[],
):
  | { skillId: string; model: string; path: string; system: string; user: string }
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
  return {
    skillId: resolved,
    model: PHASE_C_INFERENCE_SNAP,
    path: entry.path,
    system: body,
    user: [
      `Run the ${resolved} workflow as a RevDev-native pass.`,
      `Local model is the product default Inference Snap: ${PHASE_C_INFERENCE_SNAP}.`,
      'You cannot execute tools or git commits from this invoke.',
      'Produce the structured report the skill specifies.',
      'Name any command you would have run; do not claim you ran it.',
    ].join(' '),
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

export interface SkillInvokeCompletionBody {
  model: typeof PHASE_C_INFERENCE_SNAP;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  max_tokens: typeof SKILL_INVOKE_MAX_COMPLETION_TOKENS;
  stream: false;
}

/** OpenAI-compat POST body for skills.invoke. Always bounded. */
export function skillInvokeCompletionBody(system: string, user: string): SkillInvokeCompletionBody {
  return {
    model: PHASE_C_INFERENCE_SNAP,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: SKILL_INVOKE_MAX_COMPLETION_TOKENS,
    stream: false,
  };
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
