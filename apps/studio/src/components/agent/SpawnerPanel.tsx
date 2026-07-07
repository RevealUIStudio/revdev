/**
 * SpawnerPanel — spawn and manage local inference agents (Snaps / Ollama)
 *
 * Renders inside the Agent page left pane, below the workboard sessions.
 * Provides: spawn dialog, running agent list, output viewer, stop/remove.
 */

import { useRef, useState } from 'react';
import { useSpawner } from '../../hooks/use-spawner';
import type { AgentBackend } from '../../types';

export default function SpawnerPanel() {
  const { sessions, output, error, spawn, stop, remove } = useSpawner();
  const [showSpawn, setShowSpawn] = useState(false);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
          <span>Local Agents</span>
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-fg-muted">
            {sessions.length}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowSpawn(!showSpawn)}
          className="rounded bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent-soft/70"
        >
          + Spawn
        </button>
      </div>

      {showSpawn ? (
        <SpawnForm
          onSpawn={async (name, backend, model, prompt) => {
            await spawn(name, backend, model, prompt);
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
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`rounded-lg border bg-surface-1/60 p-2.5 transition-colors ${
              selectedSession === s.id ? 'border-accent/60' : 'border-edge hover:border-edge-strong'
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
                  {s.backend === 'Snap' ? 'Snap' : 'Ollama'}
                </span>
              </div>
              <p className="mt-1 truncate text-[10px] text-fg-subtle">{s.model}</p>
              <p className="mt-0.5 truncate text-[11px] leading-snug text-fg-muted">{s.prompt}</p>
            </button>

            <div className="mt-2 flex items-center gap-1">
              {s.status === 'running' ? (
                <button
                  type="button"
                  onClick={() => void stop(s.id)}
                  className="rounded bg-error-subtle px-2 py-0.5 text-[10px] text-error transition-colors hover:bg-error-subtle/70"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void remove(s.id)}
                  className="rounded bg-surface-2 px-2 py-0.5 text-[10px] text-fg-muted transition-colors hover:bg-surface-3"
                >
                  Remove
                </button>
              )}
            </div>

            {/* Inline output viewer */}
            {selectedSession === s.id && output[s.id] ? (
              <OutputViewer lines={output[s.id]} />
            ) : null}
          </div>
        ))}
      </div>

      {sessions.length === 0 && !showSpawn ? (
        <p className="px-2 py-4 text-center text-[11px] text-fg-subtle">No local agents running</p>
      ) : null}
    </div>
  );
}

// ── Spawn form ──────────────────────────────────────────────────────────────

interface SpawnFormProps {
  onSpawn: (name: string, backend: AgentBackend, model: string, prompt: string) => Promise<void>;
  onCancel: () => void;
}

function SpawnForm({ onSpawn, onCancel }: SpawnFormProps) {
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
      className="mb-3 rounded-lg border border-accent/40 bg-accent-soft p-3"
    >
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
          className="rounded bg-accent px-3 py-1 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40"
        >
          {submitting ? 'Spawning…' : 'Spawn Agent'}
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
