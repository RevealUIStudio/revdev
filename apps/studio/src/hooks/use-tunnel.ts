import { useCallback, useMemo, useState } from 'react';
import { getTailscaleStatus, tailscaleDown, tailscaleUp } from '../lib/invoke';
import type { TailscaleStatus } from '../types';
import { usePollingFetch } from './use-polling-fetch';

const POLL_INTERVAL_MS = 10_000;

export function useTunnel() {
  const [toggling, setToggling] = useState(false);
  // up/down operations produce errors not tied to the polling fetcher.
  // Tracked locally so they stay visible until cleared by a fresh action.
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchFn = useCallback(
    async (_signal: AbortSignal): Promise<TailscaleStatus> => getTailscaleStatus(),
    [],
  );

  const { data, error, loading, refresh } = usePollingFetch(fetchFn, POLL_INTERVAL_MS);

  const up = useCallback(async () => {
    setToggling(true);
    setActionError(null);
    try {
      await tailscaleUp();
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  }, [refresh]);

  const down = useCallback(async () => {
    setToggling(true);
    setActionError(null);
    try {
      await tailscaleDown();
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  }, [refresh]);

  return useMemo(
    () => ({
      // Legacy shape: status is null on error (poll failed).
      status: error ? null : (data ?? null),
      loading,
      error: actionError ?? error?.message ?? null,
      toggling,
      up,
      down,
      refresh,
    }),
    [data, error, loading, actionError, toggling, up, down, refresh],
  );
}
