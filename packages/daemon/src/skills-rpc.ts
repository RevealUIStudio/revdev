/**
 * GAP-293 Phase B/C — skills.list (read) and skills.invoke (AgentRuntime).
 *
 * Invoke uses StreamingAgentRuntime + tool-guard tools. No parallel HTTP loop.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerHandler } from './server.js';
import { listSkillCatalog } from './skill-catalog.js';
import { PHASE_C_INFERENCE_SNAP, prepareInvoke } from './skill-invoke.js';
import { runSkillInvokeRuntime } from './skill-invoke-runtime.js';

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
  return runSkillInvokeRuntime(prepared, {
    projectRoot: roots.projectRoot,
    revskillsRoot: roots.revskillsRoot,
  });
});
