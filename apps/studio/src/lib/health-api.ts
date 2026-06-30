/**
 * Studio Health API Client
 *
 * Fetches production health status from the RevealUI API's
 * /health/ready endpoint (public, no auth required).
 */

import { HttpError, httpRequest } from './http';

// ── Response types ──────────────────────────────────────────────────────────

export interface HealthCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  duration?: number;
  message?: string;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  checks: Record<string, HealthCheck> | HealthCheck[];
  corsConfigMissing?: boolean;
}

// ── Client ──────────────────────────────────────────────────────────────────

/**
 * Fetch the readiness probe from the API. Public endpoint — no auth needed.
 * Returns null if the API is unreachable, times out, or returns a non-2xx /
 * malformed response (all surfaced as {@link HttpError} by httpRequest). The
 * `res.ok` check now lives in httpRequest, so a 5xx HTML error page is no
 * longer parsed as a HealthResponse.
 *
 * Accepts an optional caller-supplied AbortSignal that's combined with
 * an internal 5 s timeout via `AbortSignal.any` — either source aborting
 * cancels the fetch. Callers using `usePollingFetch` should pass their
 * call's signal so the fetch is canceled on unmount or when a new poll
 * begins, instead of leaking a pending promise past component teardown
 * (the bug closed by revdev#43 on Dashboard.test.tsx).
 */
export async function fetchHealth(
  apiUrl: string,
  signal?: AbortSignal,
): Promise<HealthResponse | null> {
  const sources: AbortSignal[] = [AbortSignal.timeout(5_000)];
  if (signal) sources.push(signal);
  const combined = sources.length > 1 ? AbortSignal.any(sources) : sources[0];

  try {
    return await httpRequest<HealthResponse>(`${apiUrl}/health/ready`, {
      method: 'GET',
      signal: combined,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      // A degraded API can answer non-2xx (e.g. 503) yet still carry a valid
      // HealthResponse body. Surface that detail instead of collapsing the whole
      // dashboard to "Unreachable"; only a non-health body (HTML error page,
      // network failure, etc.) becomes null.
      return isHealthResponse(err.body) ? err.body : null;
    }
    throw err;
  }
}

/** Structural guard: a non-2xx body that is still a usable HealthResponse. */
function isHealthResponse(body: unknown): body is HealthResponse {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    (b.status === 'healthy' || b.status === 'degraded' || b.status === 'unhealthy') && 'checks' in b
  );
}
