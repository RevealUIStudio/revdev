/**
 * GAP-293 Phase B — skills.list
 *
 * Read-only catalog of SKILL.md trees RevDev should see (project
 * `.revealui/content/skills` + optional revskills root). No execution.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerHandler } from './server.js';
import { listSkillCatalog } from './skill-catalog.js';
import { PHASE_C_INFERENCE_SNAP, prepareInvoke } from './skill-invoke.js';

function asDir(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

export function resolveSkillRoots(params: Record<string, unknown> | undefined): {
  projectRoot: string;
  revskillsRoot: string | undefined;
} {
  const projectRoot =
    asDir(params?.projectRoot) ??
    (process.env.REVDEV_PROJECT_ROOT && process.env.REVDEV_PROJECT_ROOT.length > 0
      ? process.env.REVDEV_PROJECT_ROOT
      : process.cwd());
  const fromParam = asDir(params?.revskillsRoot);
  const fromEnv =
    process.env.REVDEV_REVSKILLS_ROOT && process.env.REVDEV_REVSKILLS_ROOT.length > 0
      ? process.env.REVDEV_REVSKILLS_ROOT
      : undefined;
  const revskillsRoot = fromParam ?? fromEnv ?? join(homedir(), 'revfleet', 'revskills');
  return { projectRoot, revskillsRoot };
}

registerHandler('skills.list', async (params) => {
  const roots = resolveSkillRoots(params);
  return {
    skills: listSkillCatalog({
      projectRoot: roots.projectRoot,
      revskillsRoot: roots.revskillsRoot,
    }),
  };
});

const SNAPS_BASE = process.env.INFERENCE_SNAPS_BASE_URL ?? 'http://localhost:9090/v1';
const INVOKE_TIMEOUT_MS = 120_000;

function asBool(value: unknown): boolean {
  return value === true;
}

registerHandler('skills.invoke', async (params) => {
  const skillId = typeof params?.skillId === 'string' ? params.skillId : '';
  const dryRun = asBool(params?.dryRun);
  const roots = resolveSkillRoots(params);
  const catalog = listSkillCatalog({
    projectRoot: roots.projectRoot,
    revskillsRoot: roots.revskillsRoot,
  });
  const prepared = prepareInvoke(skillId, catalog);
  if ('error' in prepared) {
    return { error: prepared.error, model: PHASE_C_INFERENCE_SNAP };
  }
  if (dryRun) {
    return { ...prepared, dryRun: true, ran: false };
  }
  try {
    const res = await fetch(`${SNAPS_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(INVOKE_TIMEOUT_MS),
      body: JSON.stringify({
        model: PHASE_C_INFERENCE_SNAP,
        messages: [
          { role: 'system', content: prepared.system },
          { role: 'user', content: prepared.user },
        ],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        error: `Inference Snap ${PHASE_C_INFERENCE_SNAP} failed (${res.status}): ${text}`,
        model: PHASE_C_INFERENCE_SNAP,
        hint: `Install/start: sudo snap install ${PHASE_C_INFERENCE_SNAP} && check ${SNAPS_BASE}`,
      };
    }
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content ?? '';
    return {
      skillId: prepared.skillId,
      model: PHASE_C_INFERENCE_SNAP,
      text,
      ran: true,
      toolsExecuted: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error: `Cannot reach Inference Snaps at ${SNAPS_BASE}: ${msg}`,
      model: PHASE_C_INFERENCE_SNAP,
      hint: `sudo snap install ${PHASE_C_INFERENCE_SNAP}`,
    };
  }
});
