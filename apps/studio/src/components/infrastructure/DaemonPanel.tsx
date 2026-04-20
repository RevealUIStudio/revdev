import { useCallback, useEffect, useState } from 'react';
import type { HarnessStatus } from '../../hooks/use-harness';
import {
  type DaemonStatus,
  daemonRestart,
  daemonStart,
  daemonStatus,
  daemonStop,
} from '../../lib/invoke';

interface DaemonPanelProps {
  harnessStatus: HarnessStatus;
}

export default function DaemonPanel({ harnessStatus }: DaemonPanelProps) {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await daemonStatus();
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function handleStart() {
    setLoading(true);
    setError(null);
    try {
      await daemonStart();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleStop() {
    setLoading(true);
    setError(null);
    try {
      await daemonStop();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleRestart() {
    setLoading(true);
    setError(null);
    try {
      await daemonRestart();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const statusColor =
    harnessStatus === 'connected'
      ? 'bg-green-500'
      : harnessStatus === 'connecting'
        ? 'bg-yellow-500 animate-pulse'
        : 'bg-red-500';

  const statusLabel =
    harnessStatus === 'connected'
      ? 'Connected'
      : harnessStatus === 'connecting'
        ? 'Connecting...'
        : 'Disconnected';

  return (
    <div className="space-y-4">
      {/* Status indicator */}
      <div className="flex items-center gap-3">
        <span className={`inline-block h-3 w-3 rounded-full ${statusColor}`} />
        <span className="text-sm font-medium text-neutral-200">{statusLabel}</span>
        {status?.pid && <span className="text-xs text-neutral-500">PID {status.pid}</span>}
      </div>

      {/* Controls */}
      <div className="flex gap-2">
        {!status?.running ? (
          <button
            type="button"
            onClick={handleStart}
            disabled={loading}
            className="rounded bg-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50"
          >
            {loading ? 'Starting...' : 'Start Daemon'}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={handleRestart}
              disabled={loading}
              className="rounded bg-yellow-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-yellow-600 disabled:opacity-50"
            >
              {loading ? 'Restarting...' : 'Restart'}
            </button>
            <button
              type="button"
              onClick={handleStop}
              disabled={loading}
              className="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
            >
              {loading ? 'Stopping...' : 'Stop'}
            </button>
          </>
        )}
      </div>

      {/* Error display */}
      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Daemon info */}
      {status?.reachable && (
        <div className="rounded border border-neutral-800 bg-neutral-900 p-3 text-xs text-neutral-400">
          <div>Process: {status.running ? 'Running' : 'Stopped'}</div>
          <div>Socket: {status.reachable ? 'Reachable' : 'Unreachable'}</div>
          {status.pid && <div>PID: {status.pid}</div>}
        </div>
      )}
    </div>
  );
}
