/**
 * GAP-293 Phase C — skills.invoke through StreamingAgentRuntime.
 *
 * Same loop as `@revealui/harnesses` `runNativeSkillInvoke`. Tools execute
 * via tool-guard (`executeSkillInvokeTool`), not a second HTTP chat loop.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod/v4';
import { ApprovalRequiredError, PermissionDeniedError } from './permission.js';
import {
  type NativeWorkflowToolName,
  PHASE_C_INFERENCE_SNAP,
  SKILL_INVOKE_MAX_TOOL_ROUNDS,
  skillInvokeTimeoutMs,
} from './skill-invoke.js';
import { executeSkillInvokeTool, type SkillToolContext } from './skill-invoke-tools.js';

export interface PreparedSkillInvoke {
  skillId: string;
  model: string;
  system: string;
  user: string;
  allowedTools: NativeWorkflowToolName[];
}

export interface RuntimeInvokeResult {
  skillId: string;
  model: string;
  text: string;
  ran: boolean;
  toolsExecuted: boolean;
  toolTrace: Array<{ name: string; ok: boolean }>;
  timeoutMs: number;
  error?: string;
}

type AiLoader = () => Promise<{
  StreamingAgentRuntime: new (config: {
    maxIterations?: number;
    timeout?: number;
  }) => {
    streamTask(
      agent: unknown,
      task: unknown,
      llmClient: unknown,
    ): AsyncGenerator<{
      type: string;
      content?: string;
      toolCall?: { name: string };
      toolResult?: { content?: string; success?: boolean };
      error?: string;
    }>;
    cleanup(): Promise<void>;
  };
  createLLMClientFromEnv: () => unknown;
}>;

const PARAMS: Record<NativeWorkflowToolName, z.ZodType> = {
  Read: z.object({ path: z.string() }),
  Grep: z.object({ pattern: z.string(), path: z.string().optional() }),
  Glob: z.object({ pattern: z.string(), path: z.string().optional() }),
  Bash: z.object({ command: z.string() }),
};

function toolsForGuard(allowed: readonly NativeWorkflowToolName[], ctx: SkillToolContext) {
  return allowed.map((name) => ({
    name,
    description: `${name} (tool-guarded native workflow tool)`,
    parameters: PARAMS[name],
    async execute(params: unknown): Promise<{ success: boolean; content: string }> {
      const result = await executeSkillInvokeTool(
        { id: name, name, arguments: JSON.stringify(params ?? {}) },
        allowed,
        ctx,
      );
      return { success: result.ok, content: result.text };
    },
  }));
}

async function importAiSubpath(subpath: string): Promise<Record<string, unknown>> {
  try {
    return (await import(`@revealui/ai/${subpath}`)) as Record<string, unknown>;
  } catch {
    const root = process.env.REVEALUI_MONOREPO ?? join(homedir(), 'revfleet', 'revealui');
    const file = join(root, 'packages', 'ai', 'dist', `${subpath}.js`);
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  }
}

const defaultLoadAi: AiLoader = async () => {
  const [runtimeMod, clientMod] = await Promise.all([
    importAiSubpath('orchestration/streaming-runtime'),
    importAiSubpath('llm/client'),
  ]);
  return {
    StreamingAgentRuntime: runtimeMod.StreamingAgentRuntime as Awaited<
      ReturnType<AiLoader>
    >['StreamingAgentRuntime'],
    createLLMClientFromEnv: clientMod.createLLMClientFromEnv as Awaited<
      ReturnType<AiLoader>
    >['createLLMClientFromEnv'],
  };
};

let loadAi: AiLoader = defaultLoadAi;

/** Test seam. Restores the real loader when passed undefined. */
export function setSkillInvokeAiLoaderForTests(loader?: AiLoader): void {
  loadAi = loader ?? defaultLoadAi;
}

export async function runSkillInvokeRuntime(
  prepared: PreparedSkillInvoke,
  ctx: SkillToolContext,
): Promise<RuntimeInvokeResult> {
  const timeoutMs = skillInvokeTimeoutMs(prepared.system, prepared.user);
  let ai: Awaited<ReturnType<AiLoader>>;
  try {
    ai = await loadAi();
  } catch {
    return {
      skillId: prepared.skillId,
      model: prepared.model,
      text: '',
      ran: false,
      toolsExecuted: false,
      toolTrace: [],
      timeoutMs,
      error:
        '@revealui/ai is not installed next to the daemon. Install the optional dependency so skills.invoke can use AgentRuntime.',
    };
  }

  const tools = toolsForGuard(prepared.allowedTools, ctx);
  const llmClient = ai.createLLMClientFromEnv();
  const runtime = new ai.StreamingAgentRuntime({
    maxIterations: SKILL_INVOKE_MAX_TOOL_ROUNDS,
    timeout: timeoutMs,
  });
  const agent = {
    id: 'revdev-native-skill',
    name: prepared.skillId,
    instructions: prepared.system,
    tools,
    config: {},
    getContext: () => ({
      projectRoot: ctx.projectRoot,
      workingDirectory: ctx.projectRoot,
    }),
  };
  const task = {
    id: `skill-${prepared.skillId}-${String(Date.now())}`,
    type: 'native-skill',
    description: prepared.user,
  };

  const outputParts: string[] = [];
  const toolTrace: Array<{ name: string; ok: boolean }> = [];
  try {
    for await (const chunk of runtime.streamTask(agent, task, llmClient)) {
      if (chunk.type === 'text' && chunk.content) outputParts.push(chunk.content);
      if (chunk.type === 'tool_call_start' && chunk.toolCall?.name) {
        toolTrace.push({ name: chunk.toolCall.name, ok: true });
      }
      if (chunk.type === 'tool_call_result' && chunk.toolResult) {
        const last = toolTrace[toolTrace.length - 1];
        if (last && chunk.toolResult.success === false) last.ok = false;
      }
      if (chunk.type === 'error' && chunk.error) outputParts.push(`[error] ${chunk.error}`);
    }
  } catch (err) {
    if (err instanceof ApprovalRequiredError || err instanceof PermissionDeniedError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      skillId: prepared.skillId,
      model: prepared.model,
      text: outputParts.join('\n'),
      ran: false,
      toolsExecuted: toolTrace.length > 0,
      toolTrace,
      timeoutMs,
      error: msg,
    };
  } finally {
    await runtime.cleanup();
  }

  return {
    skillId: prepared.skillId,
    model: PHASE_C_INFERENCE_SNAP,
    text: outputParts.join('\n'),
    ran: true,
    toolsExecuted: toolTrace.length > 0,
    toolTrace,
    timeoutMs,
  };
}
