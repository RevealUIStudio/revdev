import { createContext, use, useCallback, useMemo } from 'react';

import { getMountStatus, getSystemStatus } from '../lib/invoke';
import type { MountStatus, SystemStatus } from '../types';
import { usePollingFetch } from './use-polling-fetch';

const STATUS_POLL_INTERVAL_MS = 30_000;

interface StatusPayload {
  system: SystemStatus;
  mount: MountStatus;
}

export interface StatusContextValue {
  system: SystemStatus | null;
  mount: MountStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const StatusContext = createContext<StatusContextValue | null>(null);

export function useStatusContext(): StatusContextValue {
  const ctx = use(StatusContext);
  if (!ctx) throw new Error('useStatusContext must be used inside AppShell');
  return ctx;
}

export function useStatus(): StatusContextValue {
  // Fetcher is a stable identity — no caller-supplied dependencies — so
  // the polling loop only restarts on intervalMs change (which never
  // happens here; the constant is module-level).
  const fetchFn = useCallback(async (_signal: AbortSignal): Promise<StatusPayload> => {
    const [system, mount] = await Promise.all([getSystemStatus(), getMountStatus()]);
    return { system, mount };
  }, []);

  const { data, error, loading, refresh } = usePollingFetch(fetchFn, STATUS_POLL_INTERVAL_MS);

  // Preserve the legacy public surface — separate `system`/`mount`
  // slots and a string `error`. Wrapped in useMemo so consumers that
  // depend on object identity (Dashboard via context) don't re-render
  // every poll tick if the underlying data didn't change shape.
  return useMemo(
    () => ({
      system: data?.system ?? null,
      mount: data?.mount ?? null,
      loading,
      error: error?.message ?? null,
      refresh,
    }),
    [data, error, loading, refresh],
  );
}
