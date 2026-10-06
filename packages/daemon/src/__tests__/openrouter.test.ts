import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OpenRouterDb, openRouterChat } from '../openrouter.js';
import { DEFAULT_CHAIN, TRAINING_ALLOWED_CHAIN } from '../openrouter-allowlist.js';
import { validateParams } from '../validation/index.js';

const DUMMY_KEY = 'test-key-not-real';
const PROMPT = 'UNIQUE_PROMPT_NEEDLE';
const REPLY = 'UNIQUE_REPLY_NEEDLE';
const GEMMA_31 = 'google/gemma-4-31b-it:free';
const GEMMA_26 = 'google/gemma-4-26b-a4b-it:free';
const GEMMA_31_SLUG = 'google/gemma-4-31b-it-20260402';
const NEMOTRON_SUPER = 'nvidia/nemotron-3-super-120b-a12b:free';
const NEMOTRON_LIGHTNING = 'nvidia/nemotron-3.5-lightning:free';
const OFF_LIST = 'example-lab/not-on-list:free';
const FREE_ROUTER = 'openrouter/free';

const ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'REVDEV_OPENROUTER_MODEL',
  'REVDEV_OPENROUTER_ALLOW_TRAINING',
  'REVDEV_OPENROUTER_ALLOW_FREE_ROUTER',
  'REVDEV_OPENROUTER_REFERER',
  'REVDEV_OPENROUTER_TITLE',
  'REVDEV_OPENROUTER_PUBLIC_APP',
  'REVDEV_OPENROUTER_CHAT_TIMEOUT_MS',
] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function rememberEnv(): void {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const prior = saved[key];
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

function mockDb(): OpenRouterDb & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) };
}

function receiptOf(db: { query: ReturnType<typeof vi.fn> }): {
  agentId: string;
  payload: Record<string, unknown>;
  raw: string;
} {
  const calls = db.query.mock.calls.filter(
    (call) => Array.isArray(call[1]) && call[1][1] === 'inference.receipt',
  );
  const params = calls.at(-1)?.[1] as [string, string, string];
  return {
    agentId: params[0],
    payload: JSON.parse(params[2]) as Record<string, unknown>,
    raw: params[2],
  };
}

function completion(model: string, content: string = REPLY, id = 'gen-test'): string {
  return JSON.stringify({
    id,
    model,
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
  });
}

function jsonResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function requestAt(
  fetchImpl: { mock: { calls: readonly unknown[] } },
  index = 0,
): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const call = fetchImpl.mock.calls[index] as readonly unknown[] | undefined;
  if (!call) throw new Error('fetch was not called');
  const init = (call[1] ?? {}) as RequestInit;
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  return { url: String(call[0]), init, body };
}

describe('OpenRouter provider', () => {
  beforeEach(() => {
    rememberEnv();
  });

  afterEach(() => {
    restoreEnv();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns an error and does not fetch when OPENROUTER_API_KEY is missing', async () => {
    const fetchImpl = vi.fn();
    const db = mockDb();
    const result = await openRouterChat(
      { method: 'inference.chat', messages: [{ role: 'user', content: PROMPT }] },
      db,
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    expect(result).toEqual({
      error: 'OpenRouter not configured: set OPENROUTER_API_KEY in the daemon environment',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(receiptOf(db).payload.status).toBe('not_configured');
  });

  it('refuses a non-allowlisted model and openrouter/free when the opt-in is off', async () => {
    process.env.OPENROUTER_API_KEY = DUMMY_KEY;
    const fetchImpl = vi.fn();
    const db = mockDb();
    const missing = await openRouterChat(
      { method: 'inference.chat', model: OFF_LIST, messages: [{ role: 'user', content: PROMPT }] },
      db,
      { agentId: null },
      { fetch: fetchImpl },
    );
    expect(missing).toEqual({
      error: `Model "${OFF_LIST}" is not on the revdev OpenRouter US allowlist`,
    });
    const router = await openRouterChat(
      {
        method: 'inference.chat',
        model: FREE_ROUTER,
        messages: [{ role: 'user', content: PROMPT }],
      },
      db,
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    expect(router).toEqual({
      error: `Model "${FREE_ROUTER}" is not on the revdev OpenRouter US allowlist`,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(receiptOf(db).payload.status).toBe('not_allowlisted');
  });

  it('sends the default chain with data_collection deny and attribution headers', async () => {
    process.env.OPENROUTER_API_KEY = DUMMY_KEY;
    const fetchImpl = vi.fn(async () => jsonResponse(completion(GEMMA_31)));
    const db = mockDb();
    const result = await openRouterChat(
      {
        method: 'inference.chat',
        messages: [{ role: 'user', content: PROMPT }],
        temperature: 0.2,
        maxTokens: 32,
        actorAgentId: 'from-param',
      },
      db,
      { agentId: null },
      { fetch: fetchImpl, now: () => 1_000 },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, init, body } = requestAt(fetchImpl);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${DUMMY_KEY}`);
    expect(headers['HTTP-Referer']).toBe('https://revealui.com');
    expect(headers['X-OpenRouter-Title']).toBe('RevDev');
    expect(headers['X-Title']).toBe('RevDev');
    expect(headers['X-OpenRouter-App-Visibility']).toBe('hidden');
    const sent = body as {
      model: string;
      models: string[];
      stream: boolean;
      temperature: number;
      max_tokens: number;
      provider: { data_collection: string };
    };
    expect(sent.model).toBe(GEMMA_31);
    expect(sent.models).toEqual([GEMMA_31, GEMMA_26]);
    expect(sent.models).not.toContain(FREE_ROUTER);
    expect(sent.stream).toBe(false);
    expect(sent.temperature).toBe(0.2);
    expect(sent.max_tokens).toBe(32);
    expect(sent.provider.data_collection).toBe('deny');
    expect(result).toMatchObject({
      provider: 'openrouter',
      model: GEMMA_31,
      message: { role: 'assistant', content: REPLY },
      stats: { tokens: 6, promptTokens: 4, completionTokens: 6 },
    });
    const receipt = receiptOf(db);
    expect(receipt.agentId).toBe('from-param');
    expect(receipt.payload).toMatchObject({
      provider: 'openrouter',
      method: 'inference.chat',
      status: 'ok',
      model: GEMMA_31,
      modelOrigin: 'US',
      dataCollection: 'deny',
      freeRouter: false,
      fallbackUsed: false,
      generationId: 'gen-test',
    });
  });

  it('switches to the training chain and data_collection allow when opted in', async () => {
    process.env.OPENROUTER_API_KEY = DUMMY_KEY;
    process.env.REVDEV_OPENROUTER_ALLOW_TRAINING = '1';
    const fetchImpl = vi.fn(async () => jsonResponse(completion(GEMMA_31)));
    await openRouterChat(
      { method: 'inference.chat', messages: [{ role: 'user', content: PROMPT }] },
      mockDb(),
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    const body = requestAt(fetchImpl).body as {
      models: string[];
      provider: { data_collection: string };
    };
    expect(body.models).toEqual([GEMMA_31, NEMOTRON_SUPER, NEMOTRON_LIGHTNING]);
    expect(body.provider.data_collection).toBe('allow');
    expect(body.models).not.toContain(FREE_ROUTER);
  });

  it('accepts a fallback id and records fallbackUsed', async () => {
    process.env.OPENROUTER_API_KEY = DUMMY_KEY;
    const fetchImpl = vi.fn(async () => jsonResponse(completion(GEMMA_26)));
    const db = mockDb();
    const result = await openRouterChat(
      { method: 'inference.chat', messages: [{ role: 'user', content: PROMPT }] },
      db,
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    expect(result).toMatchObject({ model: GEMMA_26, message: { content: REPLY } });
    expect(receiptOf(db).payload).toMatchObject({
      status: 'ok',
      fallbackUsed: true,
      model: GEMMA_26,
    });
  });

  it('accepts the pinned canonical slug with or without :free', async () => {
    process.env.OPENROUTER_API_KEY = DUMMY_KEY;
    const fetchImpl = vi.fn(async () => jsonResponse(completion(GEMMA_31_SLUG)));
    const first = await openRouterChat(
      { method: 'inference.chat', messages: [{ role: 'user', content: PROMPT }] },
      mockDb(),
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    expect(first).toMatchObject({ model: GEMMA_31_SLUG });
    fetchImpl.mockResolvedValueOnce(jsonResponse(completion(`${GEMMA_31_SLUG}:free`)));
    const second = await openRouterChat(
      { method: 'inference.chat', messages: [{ role: 'user', content: PROMPT }] },
      mockDb(),
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    expect(second).toMatchObject({ model: `${GEMMA_31_SLUG}:free` });
  });

  it('discards an off-list response model and a model outside the requested chain', async () => {
    process.env.OPENROUTER_API_KEY = DUMMY_KEY;
    const fetchImpl = vi.fn(async () => jsonResponse(completion(OFF_LIST)));
    const db = mockDb();
    const rejected = await openRouterChat(
      { method: 'inference.chat', messages: [{ role: 'user', content: PROMPT }] },
      db,
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    expect(rejected).toEqual({
      error: `OpenRouter returned non-allowlisted model "${OFF_LIST}"; response discarded`,
    });
    expect(JSON.stringify(rejected)).not.toContain(REPLY);
    expect(receiptOf(db).payload.status).toBe('rejected_model');

    fetchImpl.mockResolvedValueOnce(jsonResponse(completion(NEMOTRON_SUPER)));
    const outsideChain = await openRouterChat(
      { method: 'inference.chat', messages: [{ role: 'user', content: PROMPT }] },
      mockDb(),
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    expect(outsideChain).toEqual({
      error: `OpenRouter returned non-allowlisted model "${NEMOTRON_SUPER}"; response discarded`,
    });
    expect(JSON.stringify(outsideChain)).not.toContain(REPLY);
  });

  it('parses 429 headers and retries at most once, only when Retry-After is 5s or less', async () => {
    process.env.OPENROUTER_API_KEY = DUMMY_KEY;
    const sleep = vi.fn(async () => {});
    const limited = () =>
      jsonResponse('', 429, {
        'retry-after': '0',
        'x-ratelimit-limit': '20',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1700000000',
      });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(limited())
      .mockResolvedValueOnce(jsonResponse(completion(GEMMA_31)));
    const recovered = await openRouterChat(
      { method: 'inference.chat', messages: [{ role: 'user', content: PROMPT }] },
      mockDb(),
      { agentId: 'agent-1' },
      { fetch: fetchImpl, sleep },
    );
    expect(recovered).toMatchObject({ model: GEMMA_31 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(0);

    const stillLimited = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValueOnce(limited());
    const db = mockDb();
    const blocked = await openRouterChat(
      { method: 'inference.chat', messages: [{ role: 'user', content: PROMPT }] },
      db,
      { agentId: 'agent-1' },
      { fetch: stillLimited, sleep: async () => {} },
    );
    expect(stillLimited).toHaveBeenCalledTimes(2);
    expect(blocked).toEqual({
      error: 'OpenRouter free-tier rate limit reached',
      rateLimited: true,
      retryAfterSeconds: 0,
      limit: 20,
      remaining: 0,
      resetAt: '1700000000',
    });
    expect(receiptOf(db).payload.status).toBe('rate_limited');

    const noRetry = vi.fn(async () =>
      jsonResponse('', 429, {
        'retry-after': '6',
        'x-ratelimit-limit': '20',
        'x-ratelimit-remaining': '1',
        'x-ratelimit-reset': '1700000001',
      }),
    );
    const held = await openRouterChat(
      { method: 'inference.chat', messages: [{ role: 'user', content: PROMPT }] },
      mockDb(),
      { agentId: 'agent-1' },
      { fetch: noRetry, sleep },
    );
    expect(noRetry).toHaveBeenCalledTimes(1);
    expect(held).toMatchObject({
      rateLimited: true,
      retryAfterSeconds: 6,
      limit: 20,
      remaining: 1,
      resetAt: '1700000001',
    });
  });

  it('writes a receipt with no prompt text and no key', async () => {
    process.env.OPENROUTER_API_KEY = DUMMY_KEY;
    const fetchImpl = vi.fn(async () => jsonResponse(completion(GEMMA_31)));
    const db = mockDb();
    await openRouterChat(
      { method: 'inference.chat', messages: [{ role: 'user', content: PROMPT }] },
      db,
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    const { raw } = receiptOf(db);
    expect(raw).not.toContain(PROMPT);
    expect(raw).not.toContain(REPLY);
    expect(raw).not.toContain(DUMMY_KEY);
    expect(raw).not.toContain('Bearer');
  });

  it('redacts the dummy key and sk-or tokens from upstream error text', async () => {
    process.env.OPENROUTER_API_KEY = DUMMY_KEY;
    const leaked = `upstream said ${DUMMY_KEY} and sk-or-EXAMPLETOKEN in the body`;
    const fetchImpl = vi.fn(async () => jsonResponse(leaked, 500));
    const db = mockDb();
    const result = await openRouterChat(
      { method: 'inference.chat', messages: [{ role: 'user', content: PROMPT }] },
      db,
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    expect(result).toEqual({
      error: 'OpenRouter request failed (500): upstream said [redacted] and [redacted] in the body',
    });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(DUMMY_KEY);
    expect(encoded).not.toContain('sk-or-EXAMPLETOKEN');
    expect(receiptOf(db).raw).not.toContain(DUMMY_KEY);
  });

  it('refuses a training-tier id until the training opt-in is set', async () => {
    process.env.OPENROUTER_API_KEY = DUMMY_KEY;
    const fetchImpl = vi.fn();
    const refused = await openRouterChat(
      {
        method: 'inference.chat',
        model: NEMOTRON_SUPER,
        messages: [{ role: 'user', content: PROMPT }],
      },
      mockDb(),
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    expect(refused).toEqual({
      error: `Model "${NEMOTRON_SUPER}" is not on the revdev OpenRouter US allowlist`,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses openrouter/free only as an explicit opt-in and still checks the response model', async () => {
    process.env.OPENROUTER_API_KEY = DUMMY_KEY;
    process.env.REVDEV_OPENROUTER_ALLOW_FREE_ROUTER = '1';
    const fetchImpl = vi.fn(async () => jsonResponse(completion(GEMMA_31)));
    const db = mockDb();
    const ok = await openRouterChat(
      {
        method: 'inference.chat',
        model: FREE_ROUTER,
        messages: [{ role: 'user', content: PROMPT }],
      },
      db,
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    const body = requestAt(fetchImpl).body as { models: string[] };
    expect(body.models).toEqual([FREE_ROUTER]);
    expect(ok).toMatchObject({ model: GEMMA_31 });
    expect(receiptOf(db).payload.freeRouter).toBe(true);

    fetchImpl.mockResolvedValueOnce(jsonResponse(completion(OFF_LIST)));
    const dropped = await openRouterChat(
      {
        method: 'inference.chat',
        model: FREE_ROUTER,
        messages: [{ role: 'user', content: PROMPT }],
      },
      mockDb(),
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    expect(dropped).toEqual({
      error: `OpenRouter returned non-allowlisted model "${OFF_LIST}"; response discarded`,
    });
    expect(JSON.stringify(dropped)).not.toContain(REPLY);
  });

  it('refuses a non-allowlisted REVDEV_OPENROUTER_MODEL without calling fetch', async () => {
    process.env.OPENROUTER_API_KEY = DUMMY_KEY;
    process.env.REVDEV_OPENROUTER_MODEL = OFF_LIST;
    const fetchImpl = vi.fn();
    const result = await openRouterChat(
      { method: 'inference.chat', messages: [{ role: 'user', content: PROMPT }] },
      mockDb(),
      { agentId: 'agent-1' },
      { fetch: fetchImpl },
    );
    expect(result).toEqual({
      error: `Model "${OFF_LIST}" is not on the revdev OpenRouter US allowlist`,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('inference.chat / inference.generate provider switch', () => {
  beforeEach(() => {
    rememberEnv();
  });

  afterEach(() => {
    restoreEnv();
    vi.unstubAllGlobals();
  });

  it('keeps the Ollama path when provider is omitted or ollama', async () => {
    vi.resetModules();
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/api/generate')) {
        return jsonResponse(
          JSON.stringify({
            response: 'local-generate',
            total_duration: 2_000_000,
            eval_count: 3,
            eval_duration: 1_000_000,
          }),
        );
      }
      return jsonResponse(
        JSON.stringify({
          message: { role: 'assistant', content: 'local-chat' },
          total_duration: 2_000_000,
          eval_count: 3,
          eval_duration: 1_000_000,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchImpl);
    const { dispatchRpc } = await import('../server.js');
    await import('../inference.js');
    const ctx = {
      agentId: null,
      agentName: null,
      boundVia: null,
      keyOrigin: null,
      verifiedSignature: null,
      preSignatureAgentId: null,
      preSignatureAgentName: null,
      preSignatureBoundVia: null,
    };
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const chat = await dispatchRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'inference.chat',
        params: { model: 'local-model', messages: [{ role: 'user', content: PROMPT }] },
      },
      db as never,
      ctx,
    );
    const generate = await dispatchRpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'inference.generate',
        params: { model: 'local-model', prompt: PROMPT, provider: 'ollama' },
      },
      db as never,
      ctx,
    );
    expect(chat.result).toMatchObject({ message: { content: 'local-chat' } });
    expect(generate.result).toMatchObject({ response: 'local-generate' });
    const urls = fetchImpl.mock.calls.map((call) => String((call as readonly unknown[])[0]));
    expect(urls.some((url) => url.includes('/api/chat'))).toBe(true);
    expect(urls.some((url) => url.includes('/api/generate'))).toBe(true);
    expect(urls.some((url) => url.includes('openrouter.ai'))).toBe(false);
    expect(chat.result).not.toHaveProperty('provider');
  });

  it('maps inference.generate onto OpenRouter chat messages', async () => {
    process.env.OPENROUTER_API_KEY = DUMMY_KEY;
    vi.resetModules();
    const fetchImpl = vi.fn(async () => jsonResponse(completion(GEMMA_31, REPLY)));
    vi.stubGlobal('fetch', fetchImpl);
    const { dispatchRpc } = await import('../server.js');
    await import('../inference.js');
    const ctx = {
      agentId: 'agent-9',
      agentName: null,
      boundVia: 'register' as const,
      keyOrigin: null,
      verifiedSignature: null,
      preSignatureAgentId: null,
      preSignatureAgentName: null,
      preSignatureBoundVia: null,
    };
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const result = await dispatchRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'inference.generate',
        params: {
          provider: 'openrouter',
          prompt: PROMPT,
          system: 'SYS_NEEDLE',
        },
      },
      db as never,
      ctx,
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      response: REPLY,
      provider: 'openrouter',
      model: GEMMA_31,
    });
    const body = requestAt(fetchImpl).body as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYS_NEEDLE' },
      { role: 'user', content: PROMPT },
    ]);
    const urls = fetchImpl.mock.calls.map((call) => String((call as readonly unknown[])[0]));
    expect(urls.every((url) => url.includes('openrouter.ai'))).toBe(true);
  });
});

describe('inference param schema', () => {
  it('requires model unless provider is openrouter', () => {
    expect(
      validateParams('inference.chat', { messages: [{ role: 'user', content: 'hi' }] }).valid,
    ).toBe(false);
    expect(
      validateParams('inference.chat', {
        provider: 'openrouter',
        messages: [{ role: 'user', content: 'hi' }],
      }).valid,
    ).toBe(true);
    expect(validateParams('inference.generate', { prompt: 'hi' }).valid).toBe(false);
    expect(
      validateParams('inference.generate', { provider: 'openrouter', prompt: 'hi' }).valid,
    ).toBe(true);
  });

  it('rejects an unknown provider and out-of-range sampling params', () => {
    expect(
      validateParams('inference.chat', {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        provider: 'other',
      }).valid,
    ).toBe(false);
    expect(
      validateParams('inference.chat', {
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 2.1,
      }).valid,
    ).toBe(false);
    expect(
      validateParams('inference.generate', { model: 'm', prompt: 'hi', maxTokens: 0 }).valid,
    ).toBe(false);
  });
});

describe('allowlist chains', () => {
  it('keeps openrouter/free out of both default chains', () => {
    expect(DEFAULT_CHAIN).toEqual([GEMMA_31, GEMMA_26]);
    expect(TRAINING_ALLOWED_CHAIN).toEqual([GEMMA_31, NEMOTRON_SUPER, NEMOTRON_LIGHTNING]);
    expect(DEFAULT_CHAIN).not.toContain(FREE_ROUTER);
    expect(TRAINING_ALLOWED_CHAIN).not.toContain(FREE_ROUTER);
  });
});
