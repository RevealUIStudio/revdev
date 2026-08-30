/**
 * GAP-293 Phase B — disk skill catalog (name / path / description).
 *
 * Lockstep with `@revealui/harnesses` `listSkillCatalog` disk walk. Daemon
 * stays free of a harnesses compile dependency (separate repo). Definitions
 * appear once content is materialized under `.revealui/content/skills`.
 * Never executes SKILL.md.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type SkillCatalogSource = 'content' | 'revskills';

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  path: string;
  source: SkillCatalogSource;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

function unquote(raw: string): string {
  if (raw.length >= 2) {
    const a = raw[0];
    const b = raw[raw.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

export function skimSkillFrontmatter(text: string): { name: string; description: string } {
  const lines = text.split('\n');
  let inFm = false;
  let name = '';
  let description = '';
  for (const line of lines) {
    if (line === '---') {
      if (!inFm) {
        inFm = true;
        continue;
      }
      break;
    }
    if (!inFm) break;
    if (line.startsWith('name:')) name = unquote(line.slice(5).trim());
    else if (line.startsWith('description:')) description = unquote(line.slice(12).trim());
  }
  return { name, description };
}

function readSkillFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

function listSkillDir(skillsDir: string, source: SkillCatalogSource): SkillCatalogEntry[] {
  let names: string[];
  try {
    names = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const out: SkillCatalogEntry[] = [];
  for (const id of names) {
    const path = join(skillsDir, id, 'SKILL.md');
    const text = readSkillFile(path);
    if (text === null) continue;
    const fields = skimSkillFrontmatter(text);
    out.push({
      id,
      name: fields.name || id,
      description: fields.description,
      path,
      source,
    });
  }
  return out;
}

export interface ListSkillCatalogOptions {
  projectRoot?: string;
  revskillsRoot?: string;
}

/** Content tree wins over revskills for the same id. */
export function listSkillCatalog(options: ListSkillCatalogOptions = {}): SkillCatalogEntry[] {
  const byId = new Map<string, SkillCatalogEntry>();
  if (options.revskillsRoot) {
    for (const entry of listSkillDir(join(options.revskillsRoot, 'skills'), 'revskills')) {
      byId.set(entry.id, entry);
    }
  }
  if (options.projectRoot) {
    const contentDir = join(options.projectRoot, '.revealui', 'content', 'skills');
    for (const entry of listSkillDir(contentDir, 'content')) {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
