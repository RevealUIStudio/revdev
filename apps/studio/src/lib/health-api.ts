/**
 * Studio Health API Client
 *
 * Fetches production health status from the RevealUI API's
 * /health/ready endpoint (public, no auth required).
 */

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
 * Returns null if the API is unreachable (network error or timeout).
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
    const res = await fetch(`${apiUrl}/health/ready`, {
      method: 'GET',
      signal: combined,
    });
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}
