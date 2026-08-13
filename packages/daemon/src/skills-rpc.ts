/**
 * GAP-293 Phase B — skills.list
 *
 * Read-only catalog of SKILL.md trees RevDev should see (project
 * `.revealui/content/skills` + optional revskills root). No execution.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'undici';
import { registerHandler } from './server.js';
import { listSkillCatalog } from './skill-catalog.js';
import {
  classifySkillInvokeFailure,
  extractSkillInvokeText,
  extractSkillInvokeToolCalls,
  PHASE_C_INFERENCE_SNAP,
  parseSkillInvokeTimeoutOverride,
  prepareInvoke,
  SKILL_INVOKE_MAX_TOOL_ROUNDS,
  type SkillInvokeMessage,
  skillInvokeCompletionBody,
  skillInvokeTimeoutMs,
} from './skill-invoke.js';
import { executeSkillInvokeTool } from './skill-invoke-tools.js';

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
  const timeoutMs = skillInvokeTimeoutMs(
    prepared.system,
    prepared.user,
    parseSkillInvokeTimeoutOverride(process.env.REVDEV_SKILLS_INVOKE_TIMEOUT_MS),
  );
  const dispatcher = new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connectTimeout: 30_000,
  });
  const messages: SkillInvokeMessage[] = [
    { role: 'system', content: prepared.system },
    { role: 'user', content: prepared.user },
  ];
  const toolTrace: Array<{ name: string; ok: boolean }> = [];
  try {
    for (let round = 0; round < SKILL_INVOKE_MAX_TOOL_ROUNDS; round += 1) {
      const res = await fetch(`${SNAPS_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher,
        body: JSON.stringify(skillInvokeCompletionBody(messages, prepared.allowedTools)),
      });
      if (!res.ok) {
        const text = await res.text();
        return {
          error: `Inference Snap ${PHASE_C_INFERENCE_SNAP} failed (${res.status}): ${text}`,
          model: PHASE_C_INFERENCE_SNAP,
          hint: `Check ${SNAPS_BASE} (${PHASE_C_INFERENCE_SNAP} status). HTTP ${String(res.status)} is not a missing-snap signal.`,
          toolsExecuted: toolTrace.length > 0,
          toolTrace,
        };
      }
      const payload: unknown = await res.json();
      const calls = extractSkillInvokeToolCalls(payload);
      if (calls.length === 0) {
        return {
          skillId: prepared.skillId,
          model: PHASE_C_INFERENCE_SNAP,
          text: extractSkillInvokeText(payload),
          ran: true,
          toolsExecuted: toolTrace.length > 0,
          toolTrace,
          timeoutMs,
        };
      }
      messages.push({
        role: 'assistant',
        content: extractSkillInvokeText(payload),
        tool_calls: calls,
      });
      for (const call of calls) {
        const result = await executeSkillInvokeTool(call, prepared.allowedTools, {
          projectRoot: roots.projectRoot,
          revskillsRoot: roots.revskillsRoot,
        });
        toolTrace.push({ name: result.name, ok: result.ok });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.text,
        });
      }
    }
    return {
      skillId: prepared.skillId,
      model: PHASE_C_INFERENCE_SNAP,
      text: 'Tool loop reached SKILL_INVOKE_MAX_TOOL_ROUNDS without a final report.',
      ran: true,
      toolsExecuted: toolTrace.length > 0,
      toolTrace,
      timeoutMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const kind = classifySkillInvokeFailure(err);
    if (kind === 'timeout') {
      return {
        error: `skills.invoke timed out after ${timeoutMs}ms waiting on ${SNAPS_BASE}`,
        model: PHASE_C_INFERENCE_SNAP,
        timeoutMs,
        hint: `Snap is reachable but the generate exceeded the prompt-sized budget. Raise REVDEV_SKILLS_INVOKE_TIMEOUT_MS (ms).`,
      };
    }
    if (kind === 'connect') {
      return {
        error: `Cannot reach Inference Snaps at ${SNAPS_BASE}: ${msg}`,
        model: PHASE_C_INFERENCE_SNAP,
        hint: `sudo snap install ${PHASE_C_INFERENCE_SNAP} && ${PHASE_C_INFERENCE_SNAP} set http.port=9090 --assume-yes`,
      };
    }
    return {
      error: `Inference Snap request failed: ${msg}`,
      model: PHASE_C_INFERENCE_SNAP,
      hint: `Check ${SNAPS_BASE} and daemon logs.`,
    };
  } finally {
    await dispatcher.close();
  }
});
