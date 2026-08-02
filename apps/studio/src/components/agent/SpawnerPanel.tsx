/**
 * SpawnerPanel — multi-agent seat for Studio
 *
 * INIT-002 PW-SPAWN:
 *   - Primary: confined daemon agent.spawn (signed + bwrap)
 *   - Secondary: local inference (Snap / Ollama) — not the daily-driver path
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSpawner } from '../../hooks/use-spawner';
import {
  harnessAgentList,
  harnessAgentRemove,
  harnessAgentSpawn,
  harnessAgentStop,
} from '../../lib/invoke';
import type { AgentBackend, HarnessAgentProcess } from '../../types';
import ConfirmDialog from '../adapters/ConfirmDialog';

type SpawnMode = 'harness' | 'local';

interface PendingAction {
  kind: 'stop' | 'remove';
  id: string;
  name: string;
  mode: SpawnMode;
}

const HARNESS_PRESETS: { label: string; command: string; args: string }[] = [
  { label: 'bash', command: 'bash', args: '-l' },
  { label: 'claude', command: 'claude', args: '' },
  { label: 'grok', command: 'grok', args: '' },
];

function defaultRepoPath(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem('git-repo-path') ?? '';
}

function harnessToSession(p: HarnessAgentProcess): {
  id: string;
  name: string;
  status: string;
  pid: number | null;
  command: string;
  cwd: string | null;
} {
  return {
    id: p.process_id,
    name: p.command,
    status:
      p.status === 'running'
        ? 'running'
        : p.status === 'exited' && (p.exit_code ?? 0) !== 0
          ? 'errored'
          : 'stopped',
    pid: p.pid,
    command: p.command,
    cwd: p.cwd,
  };
}

export default function SpawnerPanel() {
  const local = useSpawner();
  const [mode, setMode] = useState<SpawnMode>('harness');
  const [showSpawn, setShowSpawn] = useState(false);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [harnessProcs, setHarnessProcs] = useState<HarnessAgentProcess[]>([]);
  const [harnessError, setHarnessError] = useState<string | null>(null);
  const [harnessLoading, setHarnessLoading] = useState(true);

  const refreshHarness = useCallback(async () => {
    try {
      const list = await harnessAgentList();
      setHarnessProcs(list);
      setHarnessError(null);
    } catch (e) {
      setHarnessError(e instanceof Error ? e.message : String(e));
    } finally {
      setHarnessLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshHarness();
    const t = setInterval(() => void refreshHarness(), 8_000);
    return () => clearInterval(t);
  }, [refreshHarness]);

  function handleConfirmAction(): void {
    if (pendingAction === null) return;
    if (pendingAction.mode === 'local') {
      if (pendingAction.kind === 'stop') void local.stop(pendingAction.id);
      else void local.remove(pendingAction.id);
    } else {
      if (pendingAction.kind === 'stop') {
        void harnessAgentStop(pendingAction.id).then(() => refreshHarness());
      } else {
        void harnessAgentRemove(pendingAction.id).then(() => refreshHarness());
      }
    }
    setPendingAction(null);
  }

  const harnessSessions = harnessProcs.map(harnessToSession);
  const sessions = mode === 'harness' ? harnessSessions : local.sessions;
  const error = mode === 'harness' ? harnessError : local.error;
  const count = sessions.length;

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between gap-1">
        <div className="flex items-center gap-1 rounded bg-surface-2 p-0.5">
          <button
            type="button"
            onClick={() => setMode('harness')}
            className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
              mode === 'harness' ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:text-fg'
            }`}
          >
            Harness
          </button>
          <button
            type="button"
            onClick={() => setMode('local')}
            className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
              mode === 'local' ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:text-fg'
            }`}
          >
            Local inference
          </button>
        </div>
        <button
          type="button"
          onClick={() => setShowSpawn(!showSpawn)}
          className="rounded bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent-soft/70"
        >
          + Spawn
        </button>
      </div>

      <p className="mb-2 text-[10px] leading-snug text-fg-subtle">
        {mode === 'harness'
          ? 'Confined daemon agents (signed agent.spawn + bwrap). Primary multi-agent seat.'
          : 'Snap/Ollama only — local model lifecycle, not confined harness spawn.'}
        <span className="ml-1 rounded bg-surface-2 px-1 py-0.5 text-fg-muted">{count}</span>
      </p>

      {showSpawn && mode === 'harness' ? (
        <HarnessSpawnForm
          onSpawn={async (command, args, repoPath) => {
            await harnessAgentSpawn({ command, args, repoPath });
            await refreshHarness();
            setShowSpawn(false);
          }}
          onCancel={() => setShowSpawn(false)}
        />
      ) : null}

      {showSpawn && mode === 'local' ? (
        <LocalSpawnForm
          onSpawn={async (name, backend, model, prompt) => {
            await local.spawn(name, backend, model, prompt);
            setShowSpawn(false);
          }}
          onCancel={() => setShowSpawn(false)}
        />
      ) : null}

      {error ? (
        <div className="mb-2 rounded border border-error/40 bg-error-subtle px-2.5 py-2 text-[10px] text-error">
          {error}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {mode === 'harness'
          ? harnessSessions.map((s) => (
              <div
                key={s.id}
                className={`rounded-lg border bg-surface-1/60 p-2.5 transition-colors ${
                  selectedSession === s.id
                    ? 'border-accent/60'
                    : 'border-edge hover:border-edge-strong'
                }`}
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => setSelectedSession(selectedSession === s.id ? null : s.id)}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        s.status === 'running'
                          ? 'animate-pulse bg-success'
                          : s.status === 'errored'
                            ? 'bg-error'
                            : 'bg-surface-3'
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fg">
                      {s.name}
                    </span>
                    <span className="shrink-0 rounded bg-info-subtle px-1.5 py-0.5 text-[10px] text-info">
                      confined
                    </span>
                    {s.pid ? (
                      <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-subtle">
                        pid:{s.pid}
                      </span>
                    ) : null}
                  </div>
                  {s.cwd ? (
                    <p className="mt-1 truncate text-[10px] text-fg-subtle" title={s.cwd}>
                      {s.cwd}
                    </p>
                  ) : null}
                  <p className="mt-0.5 font-mono text-[10px] text-fg-muted">{s.id.slice(0, 8)}…</p>
                </button>
                <div className="mt-2 flex items-center gap-1">
                  {s.status === 'running' ? (
                    <button
                      type="button"
                      onClick={() =>
                        setPendingAction({ kind: 'stop', id: s.id, name: s.name, mode: 'harness' })
                      }
                      className="rounded bg-error-subtle px-2 py-0.5 text-[10px] text-error transition-colors hover:bg-error-subtle/70"
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        setPendingAction({
                          kind: 'remove',
                          id: s.id,
                          name: s.name,
                          mode: 'harness',
                        })
                      }
                      className="rounded bg-surface-2 px-2 py-0.5 text-[10px] text-fg-muted transition-colors hover:bg-surface-3"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            ))
          : local.sessions.map((s) => (
              <div
                key={s.id}
                className={`rounded-lg border bg-surface-1/60 p-2.5 transition-colors ${
                  selectedSession === s.id
                    ? 'border-accent/60'
                    : 'border-edge hover:border-edge-strong'
                }`}
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => setSelectedSession(selectedSession === s.id ? null : s.id)}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        s.status === 'running'
                          ? 'animate-pulse bg-success'
                          : s.status === 'errored'
                            ? 'bg-error'
                            : 'bg-surface-3'
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fg">
                      {s.name}
                    </span>
                    <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-subtle">
                      {s.backend ?? 'local'}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-[10px] text-fg-subtle">{s.model}</p>
                  <p className="mt-0.5 truncate text-[11px] leading-snug text-fg-muted">
                    {s.prompt}
                  </p>
                </button>
                <div className="mt-2 flex items-center gap-1">
                  {s.status === 'running' ? (
                    <button
                      type="button"
                      onClick={() =>
                        setPendingAction({ kind: 'stop', id: s.id, name: s.name, mode: 'local' })
                      }
                      className="rounded bg-error-subtle px-2 py-0.5 text-[10px] text-error transition-colors hover:bg-error-subtle/70"
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        setPendingAction({ kind: 'remove', id: s.id, name: s.name, mode: 'local' })
                      }
                      className="rounded bg-surface-2 px-2 py-0.5 text-[10px] text-fg-muted transition-colors hover:bg-surface-3"
                    >
                      Remove
                    </button>
                  )}
                </div>
                {selectedSession === s.id && local.output[s.id] ? (
                  <OutputViewer lines={local.output[s.id]} />
                ) : null}
              </div>
            ))}
      </div>

      {sessions.length === 0 && !showSpawn && !harnessLoading ? (
        <p className="px-2 py-4 text-center text-[11px] text-fg-subtle">
          {mode === 'harness' ? 'No confined harness agents' : 'No local inference agents'}
        </p>
      ) : null}

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction?.kind === 'stop' ? 'Stop agent' : 'Remove agent'}
        body={
          pendingAction?.kind === 'stop' ? (
            <>
              Stop the agent session <strong className="text-fg">{pendingAction.name}</strong>?
            </>
          ) : (
            <>
              Remove the agent session <strong className="text-fg">{pendingAction?.name}</strong>?
              It will disappear from this list.
            </>
          )
        }
        affectedItems={pendingAction ? [pendingAction.id] : undefined}
        confirmLabel={pendingAction?.kind === 'stop' ? 'Stop' : 'Remove'}
        onConfirm={handleConfirmAction}
        onClose={() => setPendingAction(null)}
      />
    </div>
  );
}

// ── Harness spawn form ──────────────────────────────────────────────────────

interface HarnessSpawnFormProps {
  onSpawn: (command: string, args: string[], repoPath: string) => Promise<void>;
  onCancel: () => void;
}

function HarnessSpawnForm({ onSpawn, onCancel }: HarnessSpawnFormProps) {
  const [repoPath, setRepoPath] = useState(defaultRepoPath);
  const [command, setCommand] = useState('bash');
  const [argsText, setArgsText] = useState('-l');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(command.trim() && repoPath.trim())) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const args = argsText.trim().split(/\s+/).filter(Boolean);
      if (typeof localStorage !== 'undefined' && repoPath.trim()) {
        localStorage.setItem('git-repo-path', repoPath.trim());
      }
      await onSpawn(command.trim(), args, repoPath.trim());
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="mb-3 rounded-lg border border-accent/40 bg-accent-soft p-3"
    >
      <p className="mb-2 text-[10px] text-fg-muted">
        Spawns via daemon <code className="text-fg">agent.spawn</code> (signed, confined). Requires
        a project root the Studio identity can open.
      </p>
      <label className="mb-2 block">
        <span className="mb-0.5 block text-[10px] font-medium text-fg-muted">Project root</span>
        <input
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder="/home/…/revfleet/revealui"
          className="w-full rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
        />
      </label>
      <div className="mb-2">
        <span className="mb-0.5 block text-[10px] font-medium text-fg-muted">Preset</span>
        <div className="flex flex-wrap gap-1">
          {HARNESS_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                setCommand(p.command);
                setArgsText(p.args);
              }}
              className="rounded bg-surface-2 px-2 py-0.5 text-[10px] text-fg-muted hover:bg-surface-3 hover:text-fg"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <label className="mb-2 block">
        <span className="mb-0.5 block text-[10px] font-medium text-fg-muted">Command</span>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="bash"
          className="w-full rounded border border-edge bg-surface-2 px-2 py-1 font-mono text-xs text-fg focus:border-accent focus:outline-none"
        />
      </label>
      <label className="mb-3 block">
        <span className="mb-0.5 block text-[10px] font-medium text-fg-muted">
          Args (space-separated)
        </span>
        <input
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder="-l"
          className="w-full rounded border border-edge bg-surface-2 px-2 py-1 font-mono text-xs text-fg focus:border-accent focus:outline-none"
        />
      </label>
      {formError ? (
        <div className="mb-2 rounded border border-error/40 bg-error-subtle px-2 py-1.5 text-[10px] text-error">
          {formError}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1 text-xs text-fg-muted transition-colors hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !command.trim() || !repoPath.trim()}
          className="rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40"
        >
          {submitting ? 'Spawning…' : 'Spawn confined'}
        </button>
      </div>
    </form>
  );
}

// ── Local inference form ────────────────────────────────────────────────────

interface LocalSpawnFormProps {
  onSpawn: (name: string, backend: AgentBackend, model: string, prompt: string) => Promise<void>;
  onCancel: () => void;
}

function LocalSpawnForm({ onSpawn, onCancel }: LocalSpawnFormProps) {
  const [name, setName] = useState('');
  const [backend, setBackend] = useState<AgentBackend>('Snap');
  const [model, setModel] = useState('nemotron-3-nano');
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(name.trim() && model.trim() && prompt.trim())) return;
    setSubmitting(true);
    try {
      await onSpawn(name.trim(), backend, model.trim(), prompt.trim());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="mb-3 rounded-lg border border-edge bg-surface-1 p-3"
    >
      <p className="mb-2 text-[10px] text-fg-subtle">
        Local inference only (Ubuntu Inference Snaps / Ollama). Not the confined harness path.
      </p>
      <label className="mb-2 block">
        <span className="mb-0.5 block text-[10px] font-medium text-fg-muted">Name</span>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-agent"
          className="w-full rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
        />
      </label>
      <div className="mb-2">
        <span className="mb-0.5 block text-[10px] font-medium text-fg-muted">Backend</span>
        <div className="flex gap-1.5">
          {(['Snap', 'Ollama'] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBackend(b)}
              className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                backend === b
                  ? 'bg-accent-soft text-accent ring-1 ring-accent/50'
                  : 'bg-surface-2 text-fg-muted hover:bg-surface-3'
              }`}
            >
              {b === 'Snap' ? 'Snaps' : b}
            </button>
          ))}
        </div>
      </div>
      <label className="mb-2 block">
        <span className="mb-0.5 block text-[10px] font-medium text-fg-muted">Model</span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={backend === 'Snap' ? 'nemotron-3-nano' : 'gemma4:e2b'}
          className="w-full rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
        />
      </label>
      <label className="mb-3 block">
        <span className="mb-0.5 block text-[10px] font-medium text-fg-muted">Prompt</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should this agent do?"
          rows={3}
          className="w-full resize-none rounded border border-edge bg-surface-2 px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
        />
      </label>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1 text-xs text-fg-muted transition-colors hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !name.trim() || !model.trim() || !prompt.trim()}
          className="rounded bg-surface-3 px-3 py-1 text-xs font-medium text-fg transition-colors hover:bg-surface-2 disabled:opacity-40"
        >
          {submitting ? 'Spawning…' : 'Spawn local'}
        </button>
      </div>
    </form>
  );
}

// ── Output viewer ───────────────────────────────────────────────────────────

function OutputViewer({ lines }: { lines: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={containerRef}
      className="mt-2 max-h-40 overflow-y-auto rounded bg-surface-0 p-2 font-mono text-[10px] leading-relaxed text-fg-muted"
    >
      {lines.length === 0 ? (
        <span className="italic text-fg-subtle">Waiting for output…</span>
      ) : (
        lines.map((line, i) => (
          /* biome-ignore lint/suspicious/noArrayIndexKey: append-only log output, lines never reorder and can duplicate */
          <div key={i} className="whitespace-pre-wrap break-all">
            {line}
          </div>
        ))
      )}
    </div>
  );
}
