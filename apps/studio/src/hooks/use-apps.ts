import { useCallback, useRef, useState } from 'react';
import { listApps, startApp, stopApp } from '../lib/invoke';
import type { AppStatus } from '../types';
import { usePollingFetch } from './use-polling-fetch';

/** Poll listApps until the named app matches the expected running state, or timeout. */
async function pollUntil(
  name: string,
  expectedRunning: boolean,
  setApps: (apps: AppStatus[]) => void,
  intervalMs: number,
  maxMs: number,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const result = await listApps();
    setApps(result);
    const app = result.find((a) => a.app.name === name);
    if (app?.running === expectedRunning) return;
  }
}

export function useApps() {
  const lastResultRef = useRef<AppStatus[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [operating, setOperating] = useState<Record<string, boolean>>({});

  const fetchFn = useCallback(async (_signal: AbortSignal) => {
    if (document.hidden) return lastResultRef.current;
    const result = await listApps();
    lastResultRef.current = result;
    return result;
  }, []);

  const { data, error: pollError, loading, refresh } = usePollingFetch(fetchFn, 5_000);

  const apps = data ?? lastResultRef.current;
  const error = actionError ?? pollError?.message ?? null;

  const start = useCallback(
    async (name: string) => {
      setOperating((p) => ({ ...p, [name]: true }));
      setActionError(null);
      try {
        await startApp(name);
        await pollUntil(
          name,
          true,
          (updated) => {
            lastResultRef.current = updated;
          },
          1000,
          10_000,
        );
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setOperating((p) => ({ ...p, [name]: false }));
      }
    },
    [refresh],
  );

  const stop = useCallback(
    async (name: string) => {
      setOperating((p) => ({ ...p, [name]: true }));
      setActionError(null);
      try {
        await stopApp(name);
        await pollUntil(
          name,
          false,
          (updated) => {
            lastResultRef.current = updated;
          },
          500,
          5_000,
        );
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setOperating((p) => ({ ...p, [name]: false }));
      }
    },
    [refresh],
  );

  return { apps, loading, error, operating, refresh, start, stop };
}
