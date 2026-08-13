import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE_C_INFERENCE_SNAP, prepareInvoke } from '../skill-invoke.js';

describe('prepareInvoke (GAP-293 Phase C)', () => {
  it('rejects unknown skills', () => {
    const result = prepareInvoke('preflight', []);
    expect('error' in result).toBe(true);
  });

  it('uses product default snap and forbids tool claims', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'SKILL.md');
    writeFileSync(path, '---\nname: Doc\ndescription: d\n---\n# doctor\n');
    const result = prepareInvoke('doctor', [
      { id: 'revealui-doctor', name: 'Doc', description: 'd', path, source: 'revskills' },
    ]);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.model).toBe(PHASE_C_INFERENCE_SNAP);
    expect(result.user).toContain('cannot execute tools');
  });
});
