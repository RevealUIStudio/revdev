import { useStatusContext } from '../../hooks/use-status';
import Button from '../adapters/Button';
import StatusDot from '../adapters/StatusDot';

/** Max characters for truncated error message in the status bar. */
const ERROR_TRUNCATE_LENGTH = 60;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export default function StatusBar() {
  const { system, mount, loading, error, refresh } = useStatusContext();

  return (
    <footer className="flex items-center gap-3 border-t border-edge bg-surface-1 px-4 py-1.5 text-xs text-fg-muted">
      {error ? (
        <>
          <StatusDot status="error" pulse />
          <span className="text-error" title={error}>
            {truncate(error, ERROR_TRUNCATE_LENGTH)}
          </span>
        </>
      ) : loading ? (
        <>
          <StatusDot status="warn" pulse />
          <span>Connecting...</span>
        </>
      ) : (
        <>
          {/* WSL + systemd group */}
          <div className="flex items-center gap-2">
            <StatusDot status={system?.wsl_running ? 'ok' : 'off'} />
            <span>WSL {system?.wsl_running ? 'Running' : 'Stopped'}</span>
            {system?.systemd_status ? (
              <span className="text-fg-subtle">({system.systemd_status})</span>
            ) : null}
          </div>

          <span className="text-fg-subtle">|</span>

          {/* Tier */}
          <span className="font-medium text-fg-muted">{system?.tier ?? '?'}</span>

          <span className="text-fg-subtle">|</span>

          {/* Studio drive */}
          <div className="flex items-center gap-2">
            <StatusDot status={mount?.mounted ? 'ok' : 'off'} />
            <span>Drive {mount?.mounted ? 'Mounted' : 'Unmounted'}</span>
          </div>
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="ml-auto text-fg-subtle"
        onClick={refresh}
        aria-label="Refresh status"
        title="Refresh status"
      >
        &#x21bb;
      </Button>
    </footer>
  );
}
