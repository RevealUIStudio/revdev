import { afterEach, describe, expect, it } from 'vitest';
import { runSkillInvokeRuntime, setSkillInvokeAiLoaderForTests } from '../skill-invoke-runtime.js';

describe('runSkillInvokeRuntime', () => {
  afterEach(() => {
    setSkillInvokeAiLoaderForTests();
  });

  it('fails closed when AgentRuntime cannot load', async () => {
    setSkillInvokeAiLoaderForTests(async () => {
      throw new Error('missing @revealui/ai');
    });
    const result = await runSkillInvokeRuntime(
      {
        skillId: 'revealui-doctor',
        model: 'gemma3',
        system: '# doctor',
        user: 'run',
        allowedTools: [],
      },
      { projectRoot: '/tmp' },
    );
    expect(result.ran).toBe(false);
    expect(result.error).toContain('@revealui/ai');
  });

  it('streams AgentRuntime text and records tool starts', async () => {
    setSkillInvokeAiLoaderForTests(async () => ({
      StreamingAgentRuntime: class {
        async *streamTask() {
          yield { type: 'tool_call_start', toolCall: { name: 'Read' } };
          yield { type: 'tool_call_result', toolResult: { success: true, content: 'ok' } };
          yield { type: 'text', content: 'report' };
        }
        async cleanup() {}
      },
      createLLMClientFromEnv: () => ({}),
    }));
    const result = await runSkillInvokeRuntime(
      {
        skillId: 'revealui-doctor',
        model: 'gemma3',
        system: '# doctor',
        user: 'run',
        allowedTools: ['Read'],
      },
      { projectRoot: '/tmp' },
    );
    expect(result.ran).toBe(true);
    expect(result.text).toContain('report');
    expect(result.toolsExecuted).toBe(true);
    expect(result.toolTrace).toEqual([{ name: 'Read', ok: true }]);
  });
});
