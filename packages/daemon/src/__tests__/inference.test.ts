import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('inference module — timeout configuration', () => {
  const TIMEOUT_ENV_VARS = [
    'REVDEV_OLLAMA_STATUS_TIMEOUT_MS',
    'REVDEV_OLLAMA_STOP_TIMEOUT_MS',
    'REVDEV_OLLAMA_START_TIMEOUT_MS',
    'REVDEV_OLLAMA_CHAT_TIMEOUT_MS',
    'REVDEV_OLLAMA_GENERATE_TIMEOUT_MS',
    'REVDEV_OLLAMA_PULL_TIMEOUT_MS',
  ] as const;

  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const k of TIMEOUT_ENV_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of TIMEOUT_ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('uses defaults when no env vars are set', async () => {
    const { OLLAMA_TIMEOUTS } = await import('../inference.js');
    expect(OLLAMA_TIMEOUTS.status).toBe(5_000);
    expect(OLLAMA_TIMEOUTS.stop).toBe(5_000);
    expect(OLLAMA_TIMEOUTS.start).toBe(60_000);
    expect(OLLAMA_TIMEOUTS.chat).toBe(300_000);
    expect(OLLAMA_TIMEOUTS.generate).toBe(300_000);
    expect(OLLAMA_TIMEOUTS.pull).toBe(1_800_000);
  });

  it('honors env-var overrides per operation', async () => {
    process.env.REVDEV_OLLAMA_STATUS_TIMEOUT_MS = '1000';
    process.env.REVDEV_OLLAMA_CHAT_TIMEOUT_MS = '120000';
    process.env.REVDEV_OLLAMA_PULL_TIMEOUT_MS = '900000';

    const { OLLAMA_TIMEOUTS } = await import('../inference.js');
    expect(OLLAMA_TIMEOUTS.status).toBe(1_000);
    expect(OLLAMA_TIMEOUTS.chat).toBe(120_000);
    expect(OLLAMA_TIMEOUTS.pull).toBe(900_000);
    // Unset ones still default
    expect(OLLAMA_TIMEOUTS.stop).toBe(5_000);
    expect(OLLAMA_TIMEOUTS.generate).toBe(300_000);
  });

  it('falls back to default when env var is non-numeric', async () => {
    process.env.REVDEV_OLLAMA_STATUS_TIMEOUT_MS = 'not-a-number';
    const { OLLAMA_TIMEOUTS } = await import('../inference.js');
    expect(OLLAMA_TIMEOUTS.status).toBe(5_000);
  });

  it('falls back to default when env var is zero or negative', async () => {
    process.env.REVDEV_OLLAMA_STATUS_TIMEOUT_MS = '0';
    process.env.REVDEV_OLLAMA_STOP_TIMEOUT_MS = '-1';
    const { OLLAMA_TIMEOUTS } = await import('../inference.js');
    expect(OLLAMA_TIMEOUTS.status).toBe(5_000);
    expect(OLLAMA_TIMEOUTS.stop).toBe(5_000);
  });
});

describe('inference module — isTimeoutError', () => {
  it('identifies TimeoutError (Node 20+ AbortSignal.timeout shape)', async () => {
    const { isTimeoutError } = await import('../inference.js');
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    expect(isTimeoutError(err)).toBe(true);
  });

  it('identifies AbortError (older runtime shape)', async () => {
    const { isTimeoutError } = await import('../inference.js');
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isTimeoutError(err)).toBe(true);
  });

  it('identifies DOMException-shaped TimeoutError when AbortSignal.timeout fires for real', async () => {
    const { isTimeoutError } = await import('../inference.js');
    const signal = AbortSignal.timeout(1);
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    expect(signal.aborted).toBe(true);
    expect(isTimeoutError(signal.reason)).toBe(true);
  });

  it('rejects non-abort errors', async () => {
    const { isTimeoutError } = await import('../inference.js');
    expect(isTimeoutError(new Error('connection refused'))).toBe(false);
    expect(isTimeoutError(new TypeError('fetch failed'))).toBe(false);
  });

  it('rejects non-Error values', async () => {
    const { isTimeoutError } = await import('../inference.js');
    expect(isTimeoutError(undefined)).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError('AbortError')).toBe(false);
    expect(isTimeoutError({ name: 'TimeoutError' })).toBe(false);
  });
});
