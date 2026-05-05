/**
 * useHealth — Polls the production API's readiness probe.
 *
 * Returns the health status (healthy/degraded/unhealthy/unreachable)
 * along with individual check results. Polls on the settings interval
 * via `usePollingFetch`, which gives this hook full abort + isMounted
 * hygiene without per-hook plumbing.
 */

import { useCallback, useMemo } from 'react';
import type { HealthResponse } from '../lib/health-api';
import { fetchHealth } from '../lib/health-api';
import { usePollingFetch } from './use-polling-fetch';
import { useSettingsContext } from './use-settings';

export interface HealthState {
  health: HealthResponse | null;
  reachable: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useHealth(): HealthState {
  const { settings } = useSettingsContext();
  const { apiUrl, pollingIntervalMs } = settings;

  const fetchFn = useCallback(
    (signal: AbortSignal): Promise<HealthResponse | null> => fetchHealth(apiUrl, signal),
    [apiUrl],
  );

  const { data, loading, refresh } = usePollingFetch(fetchFn, pollingIntervalMs);

  // `data === null` after a fetchHealth round-trip means the API was
  // unreachable (network error / timeout). The legacy hook surfaced
  // that as `reachable: false` rather than as an error, so we preserve
  // that mapping. Initial render (data === null, loading === true) is
  // the "no probe yet" state — keep `reachable` optimistic until we
  // see at least one resolved-to-null result.
  return useMemo<HealthState>(
    () => ({
      health: data ?? null,
      reachable: loading ? true : data !== null,
      loading,
      refresh,
    }),
    [data, loading, refresh],
  );
}
