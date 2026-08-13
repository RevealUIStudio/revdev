/**
 * GAP-293 Phase C — native workflow allowlist + prompt bind.
 * Snap: product default `nemotron-3-nano` (US-origin catalog SSOT).
 */

import { readFileSync } from 'node:fs';
import type { SkillCatalogEntry } from './skill-catalog.js';

export const NATIVE_WORKFLOW_SKILL_IDS = [
  'revealui-doctor',
  'revealui-recover',
  'revealui-checkpoint',
] as const;

export const PHASE_C_INFERENCE_SNAP = 'nemotron-3-nano';

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

export function classifySkillInvokeFailure(err: unknown): SkillInvokeFailureKind {
  if (!(err instanceof Error)) return 'other';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  const msg = err.message;
  if (/aborted due to timeout|The operation was aborted/i.test(msg)) return 'timeout';
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|Failed to parse URL/i.test(msg)) {
    return 'connect';
  }
  return 'other';
}
