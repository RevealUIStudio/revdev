/**
 * Thin OpenRouter provider. No vendor SDK. The key is read from
 * OPENROUTER_API_KEY at call time and is never logged, stored, or returned.
 */

export {
  isAllowlistedResponseModel,
  resolveOpenRouterChain,
} from './openrouter-allowlist.js';

import {
  DEFAULT_CHAIN,
  DEFAULT_OPENROUTER_MODEL,
  isAllowlistedResponseModel,
  resolveOpenRouterChain,
  TRAINING_ALLOWED_CHAIN,
} from './openrouter-allowlist.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function readTimeoutMs(envName: string, defaultMs: number): number {
  const raw = process.env[envName];
  if (!raw) return defaultMs;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
}

export const OPENROUTER_TIMEOUTS = {
  chat: readTimeoutMs('REVDEV_OPENROUTER_CHAT_TIMEOUT_MS', 120_000),
} as const;

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || err.name === 'AbortError';
}

const NOT_CONFIGURED =
  'OpenRouter not configured: set OPENROUTER_API_KEY in the daemon environment';
const RATE_LIMITED = 'OpenRouter free-tier rate limit reached';
const KEY_REJECTED = 'OpenRouter key rejected';
const BALANCE_NEGATIVE = 'OpenRouter account balance negative; free models blocked until topped up';
const CANNOT_REACH = 'Cannot reach OpenRouter';
const SK_OR_TOKEN = /sk-or-[A-Za-z0-9_-]+/g;
const ERROR_TEXT_MAX = 300;

export interface OpenRouterMessage {
  role: string;
  content: string;
}

export interface OpenRouterCallParams {
  method: 'inference.chat' | 'inference.generate';
  model?: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  maxTokens?: number;
  actorAgentId?: string;
}

export interface OpenRouterStats {
  totalMs: number;
  tokens: number;
  tokensPerSecond: number;
  promptTokens: number;
  completionTokens: number;
}

export interface OpenRouterSuccess {
  message: { role: string; content: string };
  stats: OpenRouterStats;
  provider: 'openrouter';
  model: string;
}

export interface OpenRouterFailure {
  error: string;
  rateLimited?: true;
  retryAfterSeconds?: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
}

export type OpenRouterResult = OpenRouterSuccess | OpenRouterFailure;

export interface OpenRouterDb {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

export interface OpenRouterCtx {
  agentId?: string | null;
}

export interface OpenRouterDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface OpenRouterStatus {
  configured: boolean;
  defaultModel: string;
  chain: string[];
}

interface RateLimitInfo {
  retryAfterSeconds?: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
}

interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface CompletionBody {
  id?: unknown;
  model?: unknown;
  choices?: Array<{ message?: { role?: unknown; content?: unknown } }>;
  usage?: CompletionUsage;
}

const defaultDeps: OpenRouterDeps = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

function apiKeyFrom(env: NodeJS.ProcessEnv): string {
  const key = env.OPENROUTER_API_KEY;
  if (typeof key !== 'string' || key.trim() === '') return '';
  return key;
}

function redactSecrets(text: string, apiKey: string): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  return out.replace(SK_OR_TOKEN, '[redacted]');
}

export function redactUpstreamError(text: string, apiKey: string): string {
  const redacted = redactSecrets(text, apiKey);
  return redacted.length > ERROR_TEXT_MAX ? redacted.slice(0, ERROR_TEXT_MAX) : redacted;
}

function headerInt(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function retryAfterSeconds(headers: Headers, now: number): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, Math.ceil((dateMs - now) / 1000));
}

function readRateLimit(headers: Headers, now: number): RateLimitInfo {
  const retry = retryAfterSeconds(headers, now);
  const limit = headerInt(headers, 'x-ratelimit-limit');
  const remaining = headerInt(headers, 'x-ratelimit-remaining');
  const resetRaw = headers.get('x-ratelimit-reset');
  return {
    ...(retry !== undefined ? { retryAfterSeconds: retry } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(resetRaw !== null ? { resetAt: resetRaw } : {}),
  };
}

export function buildOpenRouterHeaders(
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const title = env.REVDEV_OPENROUTER_TITLE?.trim() || 'RevDev';
  const referer = env.REVDEV_OPENROUTER_REFERER?.trim() || 'https://revealui.com';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': referer,
    'X-OpenRouter-Title': title,
    'X-Title': title,
  };
  if (env.REVDEV_OPENROUTER_PUBLIC_APP !== '1') {
    headers['X-OpenRouter-App-Visibility'] = 'hidden';
  }
  return headers;
}

export function buildOpenRouterBody(
  chain: readonly string[],
  messages: readonly OpenRouterMessage[],
  opts: { temperature?: number; maxTokens?: number },
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const models = chain.slice(0, 3);
  const dataCollection = env.REVDEV_OPENROUTER_ALLOW_TRAINING === '1' ? 'allow' : 'deny';
  const body: Record<string, unknown> = {
    model: models[0],
    models,
    messages,
    stream: false,
    provider: { data_collection: dataCollection },
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  return body;
}

export function describeOpenRouter(env: NodeJS.ProcessEnv = process.env): OpenRouterStatus {
  const configured = apiKeyFrom(env) !== '';
  const resolved = resolveOpenRouterChain(undefined, env);
  if (resolved.ok) {
    return {
      configured,
      defaultModel: resolved.chain[0] ?? DEFAULT_OPENROUTER_MODEL,
      chain: resolved.chain,
    };
  }
  const chain =
    env.REVDEV_OPENROUTER_ALLOW_TRAINING === '1' ? [...TRAINING_ALLOWED_CHAIN] : [...DEFAULT_CHAIN];
  return { configured, defaultModel: chain[0] ?? DEFAULT_OPENROUTER_MODEL, chain };
}

type ReceiptStatus =
  | 'ok'
  | 'error'
  | 'rate_limited'
  | 'rejected_model'
  | 'not_configured'
  | 'not_allowlisted';

interface ReceiptInput {
  method: OpenRouterCallParams['method'];
  requestedChain: readonly string[];
  model: string | null;
  modelOrigin: 'US' | null;
  status: ReceiptStatus;
  httpStatus: number | null;
  fallbackUsed: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
  dataCollection: 'deny' | 'allow';
  freeRouter: boolean;
  generationId: string | null;
  apiKey: string;
  actorAgentId?: string;
}

async function writeReceipt(
  db: OpenRouterDb,
  ctx: OpenRouterCtx,
  input: ReceiptInput,
): Promise<void> {
  const payload = {
    provider: 'openrouter',
    method: input.method,
    requestedChain: [...input.requestedChain],
    model: input.model,
    modelOrigin: input.modelOrigin,
    status: input.status,
    httpStatus: input.httpStatus,
    fallbackUsed: input.fallbackUsed,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens: input.totalTokens,
    latencyMs: input.latencyMs,
    dataCollection: input.dataCollection,
    freeRouter: input.freeRouter,
    generationId: input.generationId,
  };
  try {
    const agentId = ctx.agentId ?? input.actorAgentId ?? 'unbound';
    await db.query(
      'INSERT INTO events (agent_id, event_type, payload) VALUES ($1, $2, $3::jsonb)',
      [agentId, 'inference.receipt', redactSecrets(JSON.stringify(payload), input.apiKey)],
    );
  } catch {
    // Best-effort audit. A failed insert must not change the RPC result.
  }
}

function httpFailureMessage(
  status: number,
  bodyText: string,
  apiKey: string,
  dataCollection: 'deny' | 'allow',
): string {
  if (status === 401 || status === 403) return KEY_REJECTED;
  if (status === 402) return BALANCE_NEGATIVE;
  if (status === 404) {
    return `No allowlisted free endpoint matches your privacy settings (data_collection ${dataCollection}). See docs/OPENROUTER.md`;
  }
  const detail = redactUpstreamError(bodyText, apiKey);
  if (!detail) return `OpenRouter request failed (${status})`;
  return `OpenRouter request failed (${status}): ${detail}`;
}

function rateLimitResult(info: RateLimitInfo): OpenRouterFailure {
  return {
    error: RATE_LIMITED,
    rateLimited: true,
    ...(info.retryAfterSeconds !== undefined ? { retryAfterSeconds: info.retryAfterSeconds } : {}),
    ...(info.limit !== undefined ? { limit: info.limit } : {}),
    ...(info.remaining !== undefined ? { remaining: info.remaining } : {}),
    ...(info.resetAt !== undefined ? { resetAt: info.resetAt } : {}),
  };
}

function asCompletion(value: unknown): CompletionBody | null {
  if (!value || typeof value !== 'object') return null;
  return value as CompletionBody;
}

function usageNumbers(usage: CompletionUsage | undefined): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  const promptTokens =
    typeof usage?.prompt_tokens === 'number' && Number.isFinite(usage.prompt_tokens)
      ? usage.prompt_tokens
      : 0;
  const completionTokens =
    typeof usage?.completion_tokens === 'number' && Number.isFinite(usage.completion_tokens)
      ? usage.completion_tokens
      : 0;
  const totalTokens =
    typeof usage?.total_tokens === 'number' && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function boundedModelId(model: string): string {
  return model.length > 256 ? model.slice(0, 256) : model;
}

export async function openRouterChat(
  params: OpenRouterCallParams,
  db: OpenRouterDb,
  ctx: OpenRouterCtx,
  deps: Partial<OpenRouterDeps> = {},
): Promise<OpenRouterResult> {
  const fetchImpl = deps.fetch ?? defaultDeps.fetch;
  const now = deps.now ?? defaultDeps.now;
  const sleep = deps.sleep ?? defaultDeps.sleep;
  const started = now();
  const env = process.env;
  const apiKey = apiKeyFrom(env);
  let elapsedMs: number | null = null;
  const latency = () => {
    if (elapsedMs === null) elapsedMs = Math.max(0, now() - started);
    return elapsedMs;
  };

  const baseReceipt = (
    partial: Omit<ReceiptInput, 'method' | 'latencyMs' | 'apiKey' | 'actorAgentId'>,
  ) =>
    writeReceipt(db, ctx, {
      ...partial,
      method: params.method,
      latencyMs: latency(),
      apiKey,
      actorAgentId: params.actorAgentId,
    });

  if (!apiKey) {
    await baseReceipt({
      requestedChain: [],
      model: null,
      modelOrigin: null,
      status: 'not_configured',
      httpStatus: null,
      fallbackUsed: false,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      dataCollection: env.REVDEV_OPENROUTER_ALLOW_TRAINING === '1' ? 'allow' : 'deny',
      freeRouter: false,
      generationId: null,
    });
    return { error: NOT_CONFIGURED };
  }

  const resolved = resolveOpenRouterChain(params.model, env);
  if (!resolved.ok) {
    await baseReceipt({
      requestedChain: params.model?.trim() ? [params.model.trim()] : [],
      model: null,
      modelOrigin: null,
      status: 'not_allowlisted',
      httpStatus: null,
      fallbackUsed: false,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      dataCollection: env.REVDEV_OPENROUTER_ALLOW_TRAINING === '1' ? 'allow' : 'deny',
      freeRouter: false,
      generationId: null,
    });
    return { error: resolved.error };
  }

  const body = buildOpenRouterBody(
    resolved.chain,
    params.messages,
    { temperature: params.temperature, maxTokens: params.maxTokens },
    env,
  );
  const headers = buildOpenRouterHeaders(apiKey, env);
  let retried = false;

  const post = async (): Promise<Response> =>
    fetchImpl(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUTS.chat),
    });

  try {
    let response: Response;
    try {
      response = await post();
    } catch (err) {
      const message = isTimeoutError(err)
        ? `OpenRouter did not respond within ${OPENROUTER_TIMEOUTS.chat}ms`
        : CANNOT_REACH;
      await baseReceipt({
        requestedChain: resolved.chain,
        model: null,
        modelOrigin: null,
        status: 'error',
        httpStatus: null,
        fallbackUsed: false,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        dataCollection: resolved.dataCollection,
        freeRouter: resolved.freeRouter,
        generationId: null,
      });
      return { error: message };
    }

    if (response.status === 429) {
      let info = readRateLimit(response.headers, now());
      if (!retried && info.retryAfterSeconds !== undefined && info.retryAfterSeconds <= 5) {
        retried = true;
        await sleep(info.retryAfterSeconds * 1000);
        try {
          response = await post();
        } catch (err) {
          const message = isTimeoutError(err)
            ? `OpenRouter did not respond within ${OPENROUTER_TIMEOUTS.chat}ms`
            : CANNOT_REACH;
          await baseReceipt({
            requestedChain: resolved.chain,
            model: null,
            modelOrigin: null,
            status: 'error',
            httpStatus: null,
            fallbackUsed: false,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            dataCollection: resolved.dataCollection,
            freeRouter: resolved.freeRouter,
            generationId: null,
          });
          return { error: message };
        }
        if (response.status === 429) info = readRateLimit(response.headers, now());
      }
      if (response.status === 429) {
        await baseReceipt({
          requestedChain: resolved.chain,
          model: null,
          modelOrigin: null,
          status: 'rate_limited',
          httpStatus: 429,
          fallbackUsed: false,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          dataCollection: resolved.dataCollection,
          freeRouter: resolved.freeRouter,
          generationId: null,
        });
        return rateLimitResult(info);
      }
    }

    if (!response.ok) {
      const text = await response.text();
      const message = httpFailureMessage(response.status, text, apiKey, resolved.dataCollection);
      await baseReceipt({
        requestedChain: resolved.chain,
        model: null,
        modelOrigin: null,
        status: 'error',
        httpStatus: response.status,
        fallbackUsed: false,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        dataCollection: resolved.dataCollection,
        freeRouter: resolved.freeRouter,
        generationId: null,
      });
      return { error: message };
    }

    const raw = await response.text();
    let parsed: CompletionBody | null = null;
    try {
      parsed = asCompletion(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (!parsed) {
      await baseReceipt({
        requestedChain: resolved.chain,
        model: null,
        modelOrigin: null,
        status: 'error',
        httpStatus: response.status,
        fallbackUsed: false,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        dataCollection: resolved.dataCollection,
        freeRouter: resolved.freeRouter,
        generationId: null,
      });
      return { error: 'OpenRouter returned a non-JSON response' };
    }

    const generationId = typeof parsed.id === 'string' ? redactSecrets(parsed.id, apiKey) : null;
    const modelRaw = typeof parsed.model === 'string' ? parsed.model.trim() : '';
    const model = modelRaw ? boundedModelId(redactSecrets(modelRaw, apiKey)) : '';
    if (!model || !isAllowlistedResponseModel(model, resolved.chain)) {
      const shown = model || '<missing>';
      await baseReceipt({
        requestedChain: resolved.chain,
        model: model || null,
        modelOrigin: null,
        status: 'rejected_model',
        httpStatus: response.status,
        fallbackUsed: Boolean(model) && model !== resolved.chain[0],
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        dataCollection: resolved.dataCollection,
        freeRouter: resolved.freeRouter,
        generationId,
      });
      return {
        error: `OpenRouter returned non-allowlisted model "${shown}"; response discarded`,
      };
    }

    const choice = parsed.choices?.[0]?.message;
    const content = typeof choice?.content === 'string' ? choice.content : null;
    if (content === null) {
      await baseReceipt({
        requestedChain: resolved.chain,
        model,
        modelOrigin: 'US',
        status: 'error',
        httpStatus: response.status,
        fallbackUsed: model !== resolved.chain[0],
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        dataCollection: resolved.dataCollection,
        freeRouter: resolved.freeRouter,
        generationId,
      });
      return { error: 'OpenRouter returned an empty completion' };
    }

    const { promptTokens, completionTokens, totalTokens } = usageNumbers(parsed.usage);
    const totalMs = latency();
    const tokensPerSecond = totalMs > 0 ? Math.round((completionTokens / totalMs) * 1000) : 0;
    await baseReceipt({
      requestedChain: resolved.chain,
      model,
      modelOrigin: 'US',
      status: 'ok',
      httpStatus: response.status,
      fallbackUsed: model !== resolved.chain[0],
      promptTokens,
      completionTokens,
      totalTokens,
      dataCollection: resolved.dataCollection,
      freeRouter: resolved.freeRouter,
      generationId,
    });
    return {
      message: {
        role: typeof choice?.role === 'string' ? choice.role : 'assistant',
        content,
      },
      stats: {
        totalMs,
        tokens: completionTokens,
        tokensPerSecond,
        promptTokens,
        completionTokens,
      },
      provider: 'openrouter',
      model,
    };
  } catch {
    return { error: CANNOT_REACH };
  }
}
