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
