/**
 * Inference handlers — bridge between daemon RPC and Ollama HTTP API.
 *
 * These handlers provide model management and chat completion through
 * the daemon's license-gated RPC surface. Free tier gets local inference
 * if Ollama is running; Pro+ gets full management (pull, start, stop).
 *
 * Every handler enforces a per-operation timeout via AbortSignal. Without
 * this, a stuck Ollama (accepts the connection but never responds) would
 * hold the daemon socket indefinitely — any caller could DoS the daemon
 * with a single inference.status call. Timeouts are env-overridable so
 * deployers can tune for slow hardware, large models, and slow networks.
 *
 * Error envelope: every handler returns a structured response on timeout
 * or connection failure rather than throwing to the daemon's central
 * error path. This matches the existing inference.status precedent and
 * gives callers a consistent error shape they can render.
 */

import { registerHandler } from './server.js';

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

function readTimeoutMs(envName: string, defaultMs: number): number {
  const raw = process.env[envName];
  if (!raw) return defaultMs;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
}

export const OLLAMA_TIMEOUTS = {
  status: readTimeoutMs('REVDEV_OLLAMA_STATUS_TIMEOUT_MS', 5_000),
  stop: readTimeoutMs('REVDEV_OLLAMA_STOP_TIMEOUT_MS', 5_000),
  start: readTimeoutMs('REVDEV_OLLAMA_START_TIMEOUT_MS', 60_000),
  chat: readTimeoutMs('REVDEV_OLLAMA_CHAT_TIMEOUT_MS', 300_000),
  generate: readTimeoutMs('REVDEV_OLLAMA_GENERATE_TIMEOUT_MS', 300_000),
  pull: readTimeoutMs('REVDEV_OLLAMA_PULL_TIMEOUT_MS', 1_800_000),
} as const;

interface OllamaFetchOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs: number;
}

async function ollamaFetch(path: string, opts: OllamaFetchOptions): Promise<Response> {
  const { timeoutMs, headers, ...rest } = opts;
  return fetch(`${OLLAMA_URL}${path}`, {
    ...rest,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TimeoutError' || err.name === 'AbortError';
}

function timeoutMessage(op: keyof typeof OLLAMA_TIMEOUTS): string {
  return `Ollama did not respond within ${OLLAMA_TIMEOUTS[op]}ms`;
}

const CONNECT_ERROR = 'Cannot connect to Ollama. Run: ollama serve';

// ---------------------------------------------------------------------------
// inference.status — check Ollama health + loaded models
// ---------------------------------------------------------------------------

registerHandler('inference.status', async () => {
  try {
    const [versionRes, modelsRes] = await Promise.all([
      ollamaFetch('/api/version', { timeoutMs: OLLAMA_TIMEOUTS.status }),
      ollamaFetch('/api/tags', { timeoutMs: OLLAMA_TIMEOUTS.status }),
    ]);

    if (!versionRes.ok) {
      return { running: false, error: 'Ollama not responding', url: OLLAMA_URL };
    }

    const version = (await versionRes.json()) as { version: string };
    const models = (await modelsRes.json()) as {
      models: Array<{ name: string; size: number; modified_at: string }>;
    };

    return {
      running: true,
      version: version.version,
      url: OLLAMA_URL,
      models: models.models.map((m) => ({
        name: m.name,
        sizeMb: Math.round(m.size / 1_000_000),
        modified: m.modified_at,
      })),
    };
  } catch (err) {
    if (isTimeoutError(err)) {
      return { running: false, error: timeoutMessage('status'), url: OLLAMA_URL };
    }
    return { running: false, error: CONNECT_ERROR, url: OLLAMA_URL };
  }
});

// ---------------------------------------------------------------------------
// inference.pull — download a model
// ---------------------------------------------------------------------------

registerHandler('inference.pull', async (params) => {
  const { model } = params as { model: string };

  try {
    const res = await ollamaFetch('/api/pull', {
      method: 'POST',
      body: JSON.stringify({ name: model, stream: false }),
      timeoutMs: OLLAMA_TIMEOUTS.pull,
    });

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `Pull failed (${res.status}): ${text}` };
    }

    const result = (await res.json()) as { status: string };
    return { success: true, model, status: result.status };
  } catch (err) {
    if (isTimeoutError(err)) {
      return { success: false, error: timeoutMessage('pull') };
    }
    return { success: false, error: CONNECT_ERROR };
  }
});

// ---------------------------------------------------------------------------
// inference.start — load a model into memory (warm up)
// ---------------------------------------------------------------------------

registerHandler('inference.start', async (params) => {
  const { model } = params as { model: string };

  try {
    // Ollama loads models on first request — send empty generate to warm up
    const res = await ollamaFetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model, prompt: '', stream: false }),
      timeoutMs: OLLAMA_TIMEOUTS.start,
    });

    if (!res.ok) {
      const text = await res.text();
      return { loaded: false, error: `Load failed (${res.status}): ${text}` };
    }

    return { loaded: true, model };
  } catch (err) {
    if (isTimeoutError(err)) {
      return { loaded: false, error: timeoutMessage('start') };
    }
    return { loaded: false, error: CONNECT_ERROR };
  }
});

// ---------------------------------------------------------------------------
// inference.stop — unload a model from memory
// ---------------------------------------------------------------------------

registerHandler('inference.stop', async (params) => {
  const { model } = params as { model: string };

  try {
    // Ollama uses keep_alive: 0 to immediately unload
    const res = await ollamaFetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model, prompt: '', keep_alive: 0, stream: false }),
      timeoutMs: OLLAMA_TIMEOUTS.stop,
    });

    if (!res.ok) {
      return { unloaded: false, error: `Unload failed (${res.status})` };
    }

    return { unloaded: true, model };
  } catch (err) {
    if (isTimeoutError(err)) {
      return { unloaded: false, error: timeoutMessage('stop') };
    }
    return { unloaded: false, error: CONNECT_ERROR };
  }
});

// ---------------------------------------------------------------------------
// inference.chat — chat completion via Ollama
// ---------------------------------------------------------------------------

registerHandler('inference.chat', async (params) => {
  const { model, messages, temperature, maxTokens } = params as {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
  };

  try {
    const res = await ollamaFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          ...(temperature !== undefined && { temperature }),
          ...(maxTokens !== undefined && { num_predict: maxTokens }),
        },
      }),
      timeoutMs: OLLAMA_TIMEOUTS.chat,
    });

    if (!res.ok) {
      const text = await res.text();
      return { error: `Chat failed (${res.status}): ${text}` };
    }

    const result = (await res.json()) as {
      message: { role: string; content: string };
      total_duration: number;
      eval_count: number;
      eval_duration: number;
    };

    return {
      message: result.message,
      stats: {
        totalMs: Math.round(result.total_duration / 1_000_000),
        tokens: result.eval_count,
        tokensPerSecond: result.eval_duration
          ? Math.round((result.eval_count / result.eval_duration) * 1_000_000_000)
          : 0,
      },
    };
  } catch (err) {
    if (isTimeoutError(err)) {
      return { error: timeoutMessage('chat') };
    }
    return { error: CONNECT_ERROR };
  }
});

// ---------------------------------------------------------------------------
// inference.generate — raw text completion via Ollama
// ---------------------------------------------------------------------------

registerHandler('inference.generate', async (params) => {
  const { model, prompt, system, temperature, maxTokens } = params as {
    model: string;
    prompt: string;
    system?: string;
    temperature?: number;
    maxTokens?: number;
  };

  try {
    const res = await ollamaFetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        model,
        prompt,
        system,
        stream: false,
        options: {
          ...(temperature !== undefined && { temperature }),
          ...(maxTokens !== undefined && { num_predict: maxTokens }),
        },
      }),
      timeoutMs: OLLAMA_TIMEOUTS.generate,
    });

    if (!res.ok) {
      const text = await res.text();
      return { error: `Generate failed (${res.status}): ${text}` };
    }

    const result = (await res.json()) as {
      response: string;
      total_duration: number;
      eval_count: number;
      eval_duration: number;
    };

    return {
      response: result.response,
      stats: {
        totalMs: Math.round(result.total_duration / 1_000_000),
        tokens: result.eval_count,
        tokensPerSecond: result.eval_duration
          ? Math.round((result.eval_count / result.eval_duration) * 1_000_000_000)
          : 0,
      },
    };
  } catch (err) {
    if (isTimeoutError(err)) {
      return { error: timeoutMessage('generate') };
    }
    return { error: CONNECT_ERROR };
  }
});
