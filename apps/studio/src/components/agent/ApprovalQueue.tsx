/**
 * ApprovalQueue — GAP-294 Phase 2 Studio surface for permission.pending / decide.
 *
 * Operator (Studio) lists pending approvals and approves/denies with a signed
 * permission.decide. Also offers per-session mode override (permission.setMode).
 */

import { Select } from '@revealui/presentation';
import { useCallback, useEffect, useState } from 'react';
import {
  harnessPermissionDecide,
  harnessPermissionPending,
  harnessPermissionSetMode,
} from '../../lib/invoke';
import type { HarnessApproval, HarnessSession } from '../../types';
import Button from '../adapters/Button';

const POLL_MS = 5_000;

const MODE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Daemon default' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'manual', label: 'Manual' },
  { value: 'auto', label: 'Auto' },
  { value: 'agent-scoped', label: 'Agent-scoped' },
];

interface ApprovalQueueProps {
  sessions: HarnessSession[];
  connected: boolean;
  onChanged?: () => void;
}

function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ApprovalQueue({ sessions, connected, onChanged }: ApprovalQueueProps) {
  const [approvals, setApprovals] = useState<HarnessApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [modeAgent, setModeAgent] = useState('');
  const [modeValue, setModeValue] = useState('');
  const [modeBusy, setModeBusy] = useState(false);
  const [modeMsg, setModeMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!connected) {
      setApprovals([]);
      setLoading(false);
      setError(null);
      return;
    }
    try {
      const rows = await harnessPermissionPending();
      setApprovals(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [connected]);

  useEffect(() => {
    void refresh();
    if (!connected) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [connected, refresh]);

  async function decide(id: string, verdict: 'approved' | 'denied'): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await harnessPermissionDecide(id, verdict);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function applyMode(): Promise<void> {
    if (!modeAgent.trim()) return;
    setModeBusy(true);
    setModeMsg(null);
    setError(null);
    try {
      const result = await harnessPermissionSetMode(
        modeAgent.trim(),
        modeValue === '' ? null : modeValue,
      );
      setModeMsg(
        `Set ${result.agent_id} → ${result.permission_mode ?? 'daemon default'}` +
          (result.daemon_default ? ` (daemon: ${result.daemon_default})` : ''),
      );
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setModeBusy(false);
    }
  }

  const liveSessions = sessions.filter((s) => s.ended_at == null);
  const blocked = liveSessions.filter(
    (s) => s.activity_state === 'blocked' || s.blocked_reason === 'permission',
  );

  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-xs text-fg-subtle">
        Harness daemon offline — approvals unavailable
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <span className="text-xs font-semibold text-fg">Approvals</span>
        {approvals.length > 0 ? (
          <span className="rounded-full bg-warning-subtle px-1.5 py-0.5 text-[10px] font-medium text-warning">
            {approvals.length} pending
          </span>
        ) : null}
        {blocked.length > 0 ? (
          <span className="rounded-full bg-error-subtle px-1.5 py-0.5 text-[10px] font-medium text-error">
            {blocked.length} blocked
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void refresh()}
          className="ml-auto rounded px-2 py-1 text-[10px] text-fg-subtle hover:bg-surface-2 hover:text-fg-muted"
        >
          Refresh
        </Button>
      </div>

      {error ? (
        <div className="mx-3 mt-2 rounded border border-error/40 bg-error-subtle px-2.5 py-2 text-[10px] text-error">
          {error}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {loading ? (
          <p className="py-8 text-center text-xs text-fg-subtle">Loading…</p>
        ) : approvals.length === 0 ? (
          <p className="py-8 text-center text-xs text-fg-subtle">
            No pending approvals. Under shadow mode the queue stays empty until
            REVDEV_PERMISSION_MODE is manual/auto or a session override is set.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {approvals.map((a) => (
              <li key={a.id} className="rounded-lg border border-edge bg-surface-1/60 p-2.5">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-semibold text-fg">{a.method}</span>
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-subtle">
                        {a.agent_id}
                      </span>
                    </div>
                    <p className="mt-1 break-all text-[11px] text-fg-muted">{a.summary}</p>
                    <p className="mt-1 text-[10px] text-fg-subtle">
                      requested {relativeTime(a.requested_at)} · expires{' '}
                      {relativeTime(a.expires_at)}
                    </p>
                    <p className="mt-0.5 font-mono text-[9px] text-fg-subtle/80">
                      {a.params_hash.slice(0, 16)}…
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <Button
                      type="button"
                      variant="success"
                      size="sm"
                      disabled={busyId === a.id}
                      onClick={() => void decide(a.id, 'approved')}
                      className="rounded bg-success-subtle px-2 py-1 text-[10px] font-medium text-success hover:bg-success-subtle/70 disabled:opacity-40"
                    >
                      Approve
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={busyId === a.id}
                      onClick={() => void decide(a.id, 'denied')}
                      className="rounded bg-error-subtle px-2 py-1 text-[10px] font-medium text-error hover:bg-error-subtle/70 disabled:opacity-40"
                    >
                      Deny
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Per-session mode override */}
      <div className="border-t border-edge px-3 py-2">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
          Session mode override
        </div>
        <p className="mb-2 text-[10px] text-fg-subtle">
          Operator-only. Cannot set Studio&apos;s own mode. Clears to daemon default when empty.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={modeAgent}
            onChange={(e) => setModeAgent(e.target.value)}
            className="min-w-0 flex-1"
          >
            <option value="">Target session…</option>
            {liveSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
                {s.permission_mode ? ` (${s.permission_mode})` : ''}
                {s.activity_state === 'blocked' ? ' [blocked]' : ''}
              </option>
            ))}
          </Select>
          <Select value={modeValue} onChange={(e) => setModeValue(e.target.value)}>
            {MODE_OPTIONS.map((o) => (
              <option key={o.value || 'default'} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={modeBusy || !modeAgent}
            onClick={() => void applyMode()}
            className="rounded bg-info-subtle px-2 py-1 text-[10px] font-medium text-info hover:bg-info-subtle/70 disabled:opacity-40"
          >
            {modeBusy ? '…' : 'Apply'}
          </Button>
        </div>
        {modeMsg ? <p className="mt-1.5 text-[10px] text-success">{modeMsg}</p> : null}
      </div>
    </div>
  );
}
