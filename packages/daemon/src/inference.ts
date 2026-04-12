/**
 * Inference handlers — bridge between daemon RPC and Ollama HTTP API.
 *
 * These handlers provide model management and chat completion through
 * the daemon's license-gated RPC surface. Free tier gets local inference
 * if Ollama is running; Pro+ gets full management (pull, start, stop).
 */

import { registerHandler } from './server.js';

const OLLAMA_URL = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';

async function ollamaFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${OLLAMA_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
}

// ---------------------------------------------------------------------------
// inference.status — check Ollama health + loaded models
// ---------------------------------------------------------------------------

registerHandler('inference.status', async () => {
  try {
    const [versionRes, modelsRes] = await Promise.all([
      ollamaFetch('/api/version'),
      ollamaFetch('/api/tags'),
    ]);

    if (!versionRes.ok) {
      return { running: false, error: 'Ollama not responding' };
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
  } catch {
    return {
      running: false,
      error: 'Cannot connect to Ollama. Run: ollama serve',
      url: OLLAMA_URL,
    };
  }
});

// ---------------------------------------------------------------------------
// inference.pull — download a model
// ---------------------------------------------------------------------------

registerHandler('inference.pull', async (params) => {
  const { model } = params as { model: string };

  const res = await ollamaFetch('/api/pull', {
    method: 'POST',
    body: JSON.stringify({ name: model, stream: false }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: `Pull failed (${res.status}): ${text}` };
  }

  const result = (await res.json()) as { status: string };
  return { success: true, model, status: result.status };
});

// ---------------------------------------------------------------------------
// inference.start — load a model into memory (warm up)
// ---------------------------------------------------------------------------

registerHandler('inference.start', async (params) => {
  const { model } = params as { model: string };

  // Ollama loads models on first request — send empty generate to warm up
  const res = await ollamaFetch('/api/generate', {
    method: 'POST',
    body: JSON.stringify({ model, prompt: '', stream: false }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { loaded: false, error: `Load failed (${res.status}): ${text}` };
  }

  return { loaded: true, model };
});

// ---------------------------------------------------------------------------
// inference.stop — unload a model from memory
// ---------------------------------------------------------------------------

registerHandler('inference.stop', async (params) => {
  const { model } = params as { model: string };

  // Ollama uses keep_alive: 0 to immediately unload
  const res = await ollamaFetch('/api/generate', {
    method: 'POST',
    body: JSON.stringify({ model, prompt: '', keep_alive: 0, stream: false }),
  });

  if (!res.ok) {
    return { unloaded: false, error: `Unload failed (${res.status})` };
  }

  return { unloaded: true, model };
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
});
