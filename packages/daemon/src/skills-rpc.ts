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
