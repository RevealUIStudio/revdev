import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSkillCatalog, skimSkillFrontmatter } from '../skill-catalog.js';

describe('daemon skill catalog (GAP-293 Phase B)', () => {
  it('skims frontmatter only', () => {
    const fields = skimSkillFrontmatter(`---
name: Listed
description: 'Read only'
---
# must not run
`);
    expect(fields).toEqual({ name: 'Listed', description: 'Read only' });
  });

  it('lists content and revskills; content wins on id', () => {
    const project = mkdtempSync(join(tmpdir(), 'revdev-sk-proj-'));
    const revskills = mkdtempSync(join(tmpdir(), 'revdev-sk-rs-'));
    const contentDir = join(project, '.revealui/content/skills/shared');
    const rsDir = join(revskills, 'skills/shared');
    const otherDir = join(revskills, 'skills/only-rs');
    mkdirSync(contentDir, { recursive: true });
    mkdirSync(rsDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(
      join(contentDir, 'SKILL.md'),
      `---
name: From content
description: Project tree
---
`,
    );
    writeFileSync(
      join(rsDir, 'SKILL.md'),
      `---
name: From revskills
description: Should lose
---
`,
    );
    writeFileSync(
      join(otherDir, 'SKILL.md'),
      `---
name: Only revskills
description: Kept
---
`,
    );

    const list = listSkillCatalog({ projectRoot: project, revskillsRoot: revskills });
    expect(list.map((s) => s.id).sort()).toEqual(['only-rs', 'shared']);
    const shared = list.find((s) => s.id === 'shared');
    expect(shared?.source).toBe('content');
    expect(shared?.name).toBe('From content');
    expect(list.find((s) => s.id === 'only-rs')?.source).toBe('revskills');
  });

  it('returns empty when trees are missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'revdev-sk-empty-'));
    expect(listSkillCatalog({ projectRoot: root, revskillsRoot: join(root, 'nope') })).toEqual([]);
  });
});
