import { useCallback, useState } from 'react';
import { syncAllRepos, syncRepo } from '../lib/invoke';
import type { SyncResult } from '../types';

interface SyncState {
  syncingRepos: Set<string>;
  results: SyncResult[];
  log: string[];
  errors: Record<string, string>;
}

export function useSync() {
  const [state, setState] = useState<SyncState>({
    syncingRepos: new Set(),
    results: [],
    log: [],
    errors: {},
  });

  const appendLog = useCallback(
    (msg: string) => setState((prev) => ({ ...prev, log: [...prev.log, msg] })),
    [],
  );

  const syncAll = useCallback(async () => {
    setState({ syncingRepos: new Set(['__all__']), results: [], log: [], errors: {} });
    appendLog('Starting full repo sync...');
    try {
      const results = await syncAllRepos();
      appendLog(
        `Sync complete: ${results.filter((r) => r.status === 'ok').length}/${results.length} OK`,
      );
      setState((prev) => ({ ...prev, syncingRepos: new Set(), results }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog(`Error: ${msg}`);
      setState((prev) => ({
        ...prev,
        syncingRepos: new Set(),
        errors: { ...prev.errors, __all__: msg },
      }));
    }
  }, [appendLog]);

  const syncOne = useCallback(
    async (name: string) => {
      setState((prev) => ({
        ...prev,
        syncingRepos: new Set([...prev.syncingRepos, name]),
        errors: Object.fromEntries(Object.entries(prev.errors).filter(([k]) => k !== name)),
      }));
      appendLog(`Syncing ${name}...`);
      try {
        const result = await syncRepo(name);
        appendLog(`${name}: ${result.status}`);
        setState((prev) => ({
          ...prev,
          syncingRepos: new Set([...prev.syncingRepos].filter((r) => r !== name)),
          results: prev.results.map((r) =>
            r.repo === name && r.drive === result.drive ? result : r,
          ),
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(`Error: ${msg}`);
        setState((prev) => ({
          ...prev,
          syncingRepos: new Set([...prev.syncingRepos].filter((r) => r !== name)),
          errors: { ...prev.errors, [name]: msg },
        }));
      }
    },
    [appendLog],
  );

  const anySyncing = state.syncingRepos.size > 0;

  return {
    syncingRepos: state.syncingRepos,
    anySyncing,
    globalError: (state.errors['__all__'] ?? null) as string | null,
    errors: state.errors,
    results: state.results,
    log: state.log,
    syncAll,
    syncOne,
  };
}
