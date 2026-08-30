import { IconRefresh } from '@revealui/presentation';
import { useSync } from '../../hooks/use-sync';
import Button from '../adapters/Button';
import ErrorAlert from '../adapters/ErrorAlert';
import PanelHeader from '../adapters/PanelHeader';
import RepoCard from './RepoCard';
import SyncLog from './SyncLog';

export default function SyncPanel() {
  const { anySyncing, syncingRepos, globalError, errors, results, log, syncAll, syncOne } =
    useSync();

  return (
    <div className="space-y-6">
      <PanelHeader
        title="Repo Sync"
        action={
          <Button variant="primary" size="lg" onClick={syncAll} loading={anySyncing}>
            Sync All
          </Button>
        }
      />

      <ErrorAlert message={globalError} />

      {results.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {results.map((result) => {
            const key = `${result.drive}/${result.repo}`;
            return (
              <RepoCard
                key={key}
                result={result}
                onSync={() => syncOne(result.drive, result.repo)}
                syncing={syncingRepos.has(key) || syncingRepos.has('__all__')}
                error={errors[key] ?? null}
              />
            );
          })}
        </div>
      )}

      {results.length === 0 && !anySyncing && (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <div className="flex size-10 items-center justify-center rounded-lg bg-surface-2">
            <IconRefresh size="md" className="text-fg-subtle" />
          </div>
          <p className="text-sm text-fg-subtle">
            Click "Sync All" to fetch and sync all registered repos.
          </p>
        </div>
      )}

      {log.length > 0 && <SyncLog entries={log} />}
    </div>
  );
}
