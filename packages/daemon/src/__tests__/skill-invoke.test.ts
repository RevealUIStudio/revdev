import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifySkillInvokeFailure,
  extractSkillInvokeText,
  extractSkillInvokeToolCalls,
  PHASE_C_INFERENCE_SNAP,
  prepareInvoke,
  SKILL_INVOKE_MAX_COMPLETION_TOKENS,
  SKILL_INVOKE_MIN_TIMEOUT_MS,
  skillInvokeCompletionBody,
  skillInvokeTimeoutMs,
} from '../skill-invoke.js';

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
    expect(result.allowedTools).toEqual([]);
    expect(result.user).toContain('cannot execute tools');
  });

  it('advertises allowed-tools from SKILL.md on the completion body', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-tools-'));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'SKILL.md');
    writeFileSync(
      path,
      '---\nname: Doc\ndescription: d\nallowed-tools: Read, Bash\n---\n# doctor\n',
    );
    const result = prepareInvoke('doctor', [
      { id: 'revealui-doctor', name: 'Doc', description: 'd', path, source: 'revskills' },
    ]);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.allowedTools).toEqual(['Read', 'Bash']);
    expect(result.user).toContain('Use the provided tools');
    const body = skillInvokeCompletionBody(
      [
        { role: 'system', content: result.system },
        { role: 'user', content: result.user },
      ],
      result.allowedTools,
    );
    expect(body.tools?.map((t) => t.function.name)).toEqual(['Read', 'Bash']);
    expect(body.tool_choice).toBe('auto');
  });

  it('reads reasoning_content when content is empty', () => {
    expect(
      extractSkillInvokeText({
        choices: [{ message: { content: '', reasoning_content: 'traffic-light report' } }],
      }),
    ).toBe('traffic-light report');
  });

  it('caps completion tokens so a small snap cannot decode without bound', () => {
    const body = skillInvokeCompletionBody([
      { role: 'system', content: '# doctor\n' },
      { role: 'user', content: 'run doctor' },
    ]);
    expect(body.model).toBe(PHASE_C_INFERENCE_SNAP);
    expect(body.max_tokens).toBe(SKILL_INVOKE_MAX_COMPLETION_TOKENS);
    expect(body.max_tokens).toBe(2_048);
    expect(body.stream).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.messages).toEqual([
      { role: 'system', content: '# doctor\n' },
      { role: 'user', content: 'run doctor' },
    ]);
  });

  it('extracts OpenAI tool_calls', () => {
    expect(
      extractSkillInvokeToolCalls({
        choices: [
          {
            message: {
              tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"path":"x"}' } }],
            },
          },
        ],
      }),
    ).toEqual([{ id: 'c1', name: 'Read', arguments: '{"path":"x"}' }]);
  });

  it('does not use the 120s invoke cap for a doctor-sized prompt', () => {
    const timeout = skillInvokeTimeoutMs('# doctor\n'.repeat(400), 'run doctor');
    expect(timeout).toBeGreaterThan(120_000);
    expect(timeout).toBeGreaterThanOrEqual(SKILL_INVOKE_MIN_TIMEOUT_MS);
  });

  it('classifies abort-as-timeout separately from connect failure', () => {
    const abort = new Error('The operation was aborted due to timeout');
    abort.name = 'AbortError';
    expect(classifySkillInvokeFailure(abort)).toBe('timeout');
    expect(classifySkillInvokeFailure(new Error('connect ECONNREFUSED 127.0.0.1:9090'))).toBe(
      'connect',
    );
  });

  it('classifies undici fetch-failed header timeouts as timeout not connect', () => {
    const cause = new Error('Headers Timeout Error');
    cause.name = 'HeadersTimeoutError';
    (cause as Error & { code?: string }).code = 'UND_ERR_HEADERS_TIMEOUT';
    const wrapped = new Error('fetch failed', { cause });
    wrapped.name = 'TypeError';
    expect(classifySkillInvokeFailure(wrapped)).toBe('timeout');
  });
});
