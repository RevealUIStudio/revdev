import type { SyncResult } from '../../types';
import Button from '../ui/Button';
import Card from '../ui/Card';

interface RepoCardProps {
  result: SyncResult;
  onSync: () => void;
  syncing: boolean;
  error: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  ok: 'text-success',
  dirty: 'text-warning',
  diverged: 'text-warning',
  skip: 'text-fg-subtle',
  reset_failed: 'text-error',
  error: 'text-error',
};

export default function RepoCard({ result, onSync, syncing, error }: RepoCardProps) {
  return (
    <Card variant="default" padding="none" className="flex items-center justify-between px-4 py-3">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg">{result.repo}</span>
          <span className="text-xs text-fg-subtle">{result.drive}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs">
          <span className={STATUS_STYLES[result.status] ?? 'text-fg-muted'}>
            {result.status.toUpperCase()}
          </span>
          <span className="text-fg-subtle">{result.branch}</span>
        </div>
        {error !== null && <p className="mt-1 text-xs text-error">{error}</p>}
      </div>
      <Button variant="ghost" size="sm" onClick={onSync} disabled={syncing}>
        Sync
      </Button>
    </Card>
  );
}
