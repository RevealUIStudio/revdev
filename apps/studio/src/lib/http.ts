/**
 * Shared HTTP request contract for Studio's API clients.
 *
 * Every fetch against the RevealUI API or daemon should go through
 * {@link httpRequest} so failures are categorized in one place instead of each
 * client guessing: `client` (4xx — usually actionable by the user), `server`
 * (5xx), `network` (unreachable, timeout, or aborted), or `parse` (a 2xx with a
 * malformed body). Callers can surface `error.message` directly — it is already
 * written for a human — and branch on `error.kind` when they need to.
 *
 * Closes the Theme 4 finding that `res.ok` was unchecked and raw `TypeError` /
 * `SyntaxError` leaked out as "Unable to reach the API" for every failure mode.
 */

export type HttpErrorKind = 'client' | 'server' | 'network' | 'parse';

export class HttpError extends Error {
  readonly kind: HttpErrorKind;
  readonly status?: number;
  /** Parsed response body, when present — a non-2xx response may carry a server message. */
  readonly body?: unknown;

  constructor(message: string, kind: HttpErrorKind, status?: number, body?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

/** Pull a human-readable message out of a JSON error body, if one is present. */
function messageFromBody(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) return record.error;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
  }
  return undefined;
}

/** Read and parse a JSON body without throwing — returns undefined on any failure. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * Fetch `url` and return the parsed JSON body of a 2xx response.
 *
 * Throws {@link HttpError} (never a raw `TypeError` or `SyntaxError`) for every
 * failure mode, with `kind` set so callers can branch and `message` set to the
 * server-provided error when the body carried one.
 */
export async function httpRequest<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new HttpError('The request timed out or was canceled.', 'network');
    }
    throw new HttpError(
      'Unable to reach the server. Check your connection and try again.',
      'network',
    );
  }

  if (!res.ok) {
    const body = await readJson(res);
    const kind: HttpErrorKind = res.status >= 500 ? 'server' : 'client';
    const fallback =
      kind === 'server'
        ? `The server encountered an error (${res.status}). Please try again later.`
        : `Request failed (${res.status}).`;
    throw new HttpError(messageFromBody(body) ?? fallback, kind, res.status, body);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new HttpError('The server returned a malformed response.', 'parse', res.status);
  }
}
