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
    // Keyed on the drive/repo composite — rows are unique by (drive, repo), so a
    // repo present on two drives must not share one spinner/error or collide.
    async (drive: string, repo: string) => {
      const key = `${drive}/${repo}`;
      setState((prev) => ({
        ...prev,
        syncingRepos: new Set([...prev.syncingRepos, key]),
        errors: Object.fromEntries(Object.entries(prev.errors).filter(([k]) => k !== key)),
      }));
      appendLog(`Syncing ${repo}...`);
      try {
        const result = await syncRepo(repo);
        appendLog(`${repo}: ${result.status}`);
        setState((prev) => ({
          ...prev,
          syncingRepos: new Set([...prev.syncingRepos].filter((r) => r !== key)),
          results: prev.results.map((r) => (r.drive === drive && r.repo === repo ? result : r)),
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(`Error: ${msg}`);
        setState((prev) => ({
          ...prev,
          syncingRepos: new Set([...prev.syncingRepos].filter((r) => r !== key)),
          errors: { ...prev.errors, [key]: msg },
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
