/**
 * Studio Billing API Client
 *
 * Communicates with the RevealUI API's /api/billing endpoints
 * using the device bearer token for authentication.
 */

import { httpRequest } from './http';

// ── Response types ──────────────────────────────────────────────────────────

export type BillingTier = 'free' | 'pro' | 'max' | 'enterprise';

export interface SubscriptionResponse {
  tier: BillingTier;
  status: string;
  expiresAt: string | null;
  licenseKey: string | null;
  graceUntil?: string | null;
}

export interface UsageResponse {
  used: number;
  quota: number;
  overage: number;
  cycleStart: string;
  resetAt: string;
}

// ── Client ──────────────────────────────────────────────────────────────────

/**
 * Authenticated GET against the billing API. Routes through httpRequest so a
 * non-2xx response throws a categorized {@link HttpError} with an actionable,
 * server-provided message (instead of the old bare `returned 500`), and a
 * malformed body is reported as a parse error rather than leaking a SyntaxError.
 */
async function authedGet<T>(
  apiUrl: string,
  path: string,
  token: string,
  signal?: AbortSignal,
): Promise<T> {
  return httpRequest<T>(`${apiUrl}/api/billing${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal,
  });
}

/**
 * Fetch the current user's subscription/license status. Accepts an
 * optional AbortSignal so callers (usePollingFetch) can cancel the
 * fetch on unmount or when a new poll begins.
 */
export async function fetchSubscription(
  apiUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<SubscriptionResponse> {
  return authedGet<SubscriptionResponse>(apiUrl, '/subscription', token, signal);
}

/**
 * Fetch the current billing cycle's agent task usage. Accepts an
 * optional AbortSignal — see fetchSubscription.
 */
export async function fetchUsage(
  apiUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<UsageResponse> {
  return authedGet<UsageResponse>(apiUrl, '/usage', token, signal);
}
