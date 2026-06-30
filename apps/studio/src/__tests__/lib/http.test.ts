import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError, httpRequest } from '../../lib/http';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    // httpRequest reads 2xx bodies via text()+JSON.parse and error bodies via
    // json(); provide both so the mock matches the real Response surface.
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
    text: async () => '',
  } as unknown as Response;
}

function malformedResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
    text: async () => '<not json>',
  } as unknown as Response;
}

/** Await a request expected to reject, returning the thrown HttpError (typed). */
async function expectHttpError(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('expected httpRequest to throw, but it resolved');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('httpRequest', () => {
  it('returns the parsed body of a 2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, value: 42 })));
    await expect(httpRequest<{ value: number }>('https://x/ok')).resolves.toEqual({
      ok: true,
      value: 42,
    });
  });

  it('throws a client HttpError carrying the server message on 4xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(429, { error: 'Too many requests' })),
    );
    const err = await expectHttpError(httpRequest('https://x/rate'));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.kind).toBe('client');
    expect(err.status).toBe(429);
    expect(err.message).toBe('Too many requests');
    expect(err.body).toEqual({ error: 'Too many requests' });
  });

  it('throws a server HttpError with a fallback message on 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})));
    const err = await expectHttpError(httpRequest('https://x/boom'));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.kind).toBe('server');
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/server encountered an error/i);
  });

  it('throws a network HttpError when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await expectHttpError(httpRequest('https://x/down'));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/unable to reach/i);
  });

  it('classifies an aborted fetch as a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')));
    const err = await expectHttpError(httpRequest('https://x/slow'));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/timed out or was canceled/i);
  });

  it('throws a parse HttpError when a 2xx body is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(malformedResponse(200)));
    const err = await expectHttpError(httpRequest('https://x/garbage'));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.kind).toBe('parse');
  });
});
