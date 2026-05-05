/**
 * useSubscription — Fetches and caches subscription + usage data from the API.
 *
 * Polls on an interval (from settings.pollingIntervalMs) so the Dashboard
 * always reflects the current billing state without manual refresh.
 * Polling is gated on `step === 'authenticated'` AND `getToken()` returning
 * a token. When either gate is closed the fetcher returns null and the
 * underlying API calls are skipped.
 */

import { useCallback, useMemo } from 'react';
import type { SubscriptionResponse, UsageResponse } from '../lib/billing-api';
import { fetchSubscription, fetchUsage } from '../lib/billing-api';
import { useAuthContext } from './use-auth';
import { usePollingFetch } from './use-polling-fetch';
import { useSettingsContext } from './use-settings';

export interface SubscriptionState {
  subscription: SubscriptionResponse | null;
  usage: UsageResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

interface BillingPayload {
  subscription: SubscriptionResponse;
  usage: UsageResponse;
}

const FALLBACK_ERROR = 'Failed to fetch billing data';

export function useSubscription(): SubscriptionState {
  const { getToken, step } = useAuthContext();
  const { settings } = useSettingsContext();
  const { apiUrl, pollingIntervalMs } = settings;

  const fetchFn = useCallback(
    async (signal: AbortSignal): Promise<BillingPayload | null> => {
      // Gate: skip the network entirely when not authenticated or no
      // token. Returning null leaves data unchanged (still null after
      // first call) and the helper's loading transitions to false.
      if (step !== 'authenticated') return null;
      const token = getToken();
      if (!token) return null;

      try {
        const [sub, usg] = await Promise.all([
          fetchSubscription(apiUrl, token, signal),
          fetchUsage(apiUrl, token, signal),
        ]);
        return { subscription: sub, usage: usg };
      } catch (err) {
        // Re-throw Error instances unchanged so the consumer surfaces
        // the real message; replace non-Error rejections with the
        // legacy fallback string for caller compatibility.
        if (err instanceof Error) throw err;
        throw new Error(FALLBACK_ERROR);
      }
    },
    [apiUrl, getToken, step],
  );

  // Disable interval polling until the user is authenticated. The
  // initial fetch still fires once per fetchFn-identity change, but
  // when step !== 'authenticated' the gate above short-circuits the
  // network call, so no fetchSubscription/fetchUsage requests go out.
  const effectiveInterval = step === 'authenticated' ? pollingIntervalMs : null;

  const { data, error, loading, refresh } = usePollingFetch(fetchFn, effectiveInterval);

  return useMemo<SubscriptionState>(
    () => ({
      subscription: data?.subscription ?? null,
      usage: data?.usage ?? null,
      loading,
      error: error?.message ?? null,
      refresh,
    }),
    [data, error, loading, refresh],
  );
}
