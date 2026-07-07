/**
 * InferencePanel — local AI inference management
 *
 * Two engines: Ubuntu Inference Snaps (recommended), Ollama (fallback).
 * Shows installed status, available models, install/pull/delete, server start/stop.
 */

import { useState } from 'react';

import { useInference } from '../../hooks/use-inference';
import ConfirmDialog from '../ui/ConfirmDialog';

interface PendingDelete {
  kind: 'model' | 'snapshot';
  name: string;
}

export default function InferencePanel() {
  const {
    ollama,
    models,
    snaps,
    loading,
    error,
    pulling,
    installingSnap,
    refresh,
    startOllama,
    stopOllama,
    pullModel,
    deleteModel,
    installSnap,
    removeSnap,
  } = useInference();

  const [pullInput, setPullInput] = useState('');
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  function handleConfirmDelete(): void {
    if (pendingDelete === null) return;
    if (pendingDelete.kind === 'model') {
      void deleteModel(pendingDelete.name);
    } else {
      void removeSnap(pendingDelete.name);
    }
    setPendingDelete(null);
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-fg-subtle">Checking inference engines…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-fg">Local Inference</h1>
          <p className="mt-0.5 text-xs text-fg-subtle">
            Manage local AI models — no cloud, no API keys, fully sovereign
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded bg-surface-2 px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-3"
        >
          Refresh
        </button>
      </div>

      {error ? (
        <div className="mb-4 rounded border border-error/50 bg-error-subtle px-3 py-2 text-xs text-error">
          {error}
        </div>
      ) : null}

      {/* ── Engine status cards ── */}
      <div className="mb-6 grid grid-cols-2 gap-4">
        {/* Inference Snaps */}
        <div className="rounded-lg border border-edge bg-surface-1/60 p-4">
          <div className="flex items-center gap-2">
            <span
              className={`size-2.5 shrink-0 rounded-full ${
                snaps.some((s) => s.installed) ? 'bg-success' : 'bg-surface-2'
              }`}
            />
            <h2 className="text-sm font-semibold text-fg">Snaps</h2>
            <span className="rounded bg-warning-subtle px-1.5 py-0.5 text-[9px] font-medium text-warning">
              recommended
            </span>
          </div>
          <p className="mt-1 text-[11px] text-fg-subtle">
            Ubuntu Inference Snaps — one command install
          </p>
          <div className="mt-3">
            {snaps.some((s) => s.installed) ? (
              <span className="inline-block rounded bg-success-subtle px-2 py-0.5 text-[10px] font-medium text-success">
                {snaps.filter((s) => s.installed).length} installed
              </span>
            ) : (
              <span className="inline-block rounded bg-surface-2 px-2 py-0.5 text-[10px] text-fg-subtle">
                None installed
              </span>
            )}
          </div>
        </div>

        {/* Ollama */}
        <div className="rounded-lg border border-edge bg-surface-1/60 p-4">
          <div className="flex items-center gap-2">
            <span
              className={`size-2.5 shrink-0 rounded-full ${
                ollama?.running ? 'bg-success' : ollama?.installed ? 'bg-warning' : 'bg-surface-2'
              }`}
            />
            <h2 className="text-sm font-semibold text-fg">Ollama</h2>
            {ollama?.version ? (
              <span className="text-[10px] text-fg-subtle">{ollama.version}</span>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] text-fg-subtle">Run open models — Gemma, Qwen, Mistral</p>
          <div className="mt-3 flex items-center gap-2">
            {ollama?.installed ? (
              ollama.running ? (
                <>
                  <span className="inline-block rounded bg-success-subtle px-2 py-0.5 text-[10px] font-medium text-success">
                    Running
                  </span>
                  <button
                    type="button"
                    onClick={() => void stopOllama()}
                    className="rounded bg-error-subtle px-2 py-0.5 text-[10px] text-error transition-colors hover:bg-error-subtle/50"
                  >
                    Stop
                  </button>
                </>
              ) : (
                <>
                  <span className="inline-block rounded bg-warning-subtle px-2 py-0.5 text-[10px] font-medium text-warning">
                    Stopped
                  </span>
                  <button
                    type="button"
                    onClick={() => void startOllama()}
                    className="rounded bg-success-subtle px-2 py-0.5 text-[10px] text-success transition-colors hover:bg-success-subtle/50"
                  >
                    Start
                  </button>
                </>
              )
            ) : (
              <span className="inline-block rounded bg-surface-2 px-2 py-0.5 text-[10px] text-fg-subtle">
                Not installed
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Inference Snaps section ── */}
      <div className="mb-6 rounded-lg border border-edge bg-surface-1/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Inference Snaps</h2>
          <span className="text-[10px] text-fg-subtle">sudo snap install &lt;name&gt;</span>
        </div>
        <div className="divide-y divide-edge">
          {snaps.map((snap) => (
            <div key={snap.name} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-fg">{snap.name}</span>
                <span className="text-[10px] text-fg-subtle">{snap.description}</span>
              </div>
              {snap.installed ? (
                <div className="flex items-center gap-2">
                  <span className="rounded bg-success-subtle px-2 py-0.5 text-[10px] font-medium text-success">
                    Installed
                  </span>
                  <button
                    type="button"
                    onClick={() => setPendingDelete({ kind: 'snapshot', name: snap.name })}
                    className="rounded px-2 py-0.5 text-[10px] text-fg-subtle transition-colors hover:bg-error-subtle hover:text-error"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => void installSnap(snap.name)}
                  disabled={installingSnap !== null}
                  className="shrink-0 rounded bg-warning-subtle px-3 py-1 text-[10px] font-medium text-warning transition-colors hover:bg-warning-subtle/50 disabled:opacity-40"
                >
                  {installingSnap === snap.name ? 'Installing…' : 'Install'}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Ollama models ── */}
      <div className="rounded-lg border border-edge bg-surface-1/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">Ollama Models</h2>
          <span className="text-[10px] text-fg-subtle">
            {models.length} model{models.length !== 1 ? 's' : ''} available
          </span>
        </div>

        {/* Pull form */}
        {ollama?.running ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (pullInput.trim()) {
                void pullModel(pullInput.trim());
                setPullInput('');
              }
            }}
            className="mb-3 flex gap-2"
          >
            <input
              value={pullInput}
              onChange={(e) => setPullInput(e.target.value)}
              placeholder="Pull a model (e.g. gemma4:e2b, qwen3.5, mistral)"
              disabled={pulling}
              className="flex-1 rounded border border-edge-strong bg-surface-2 px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={pulling || !pullInput.trim()}
              className="shrink-0 rounded bg-brand px-3 py-1.5 text-xs font-medium text-on-brand transition-colors hover:bg-brand-hover disabled:opacity-40"
            >
              {pulling ? 'Pulling…' : 'Pull'}
            </button>
          </form>
        ) : null}

        {models.length > 0 ? (
          <div className="divide-y divide-edge">
            {models.map((m) => (
              <div key={m.name} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-fg">{m.name}</span>
                  <span className="text-[10px] text-fg-subtle">
                    {m.size} · {m.modified}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setPendingDelete({ kind: 'model', name: m.name })}
                  className="shrink-0 rounded px-2 py-0.5 text-[10px] text-fg-subtle transition-colors hover:bg-error-subtle hover:text-error"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-6 text-center text-xs text-fg-subtle">
            {ollama?.running
              ? 'No models downloaded yet — pull one above'
              : ollama?.installed
                ? 'Start the Ollama server to manage models'
                : 'Install Ollama to download and run models locally'}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.kind === 'model' ? 'Delete model' : 'Remove snap'}
        body={
          pendingDelete?.kind === 'model' ? (
            <>
              Delete <strong className="text-fg">{pendingDelete.name}</strong>? The model files will
              be removed from disk. Re-downloading it is a multi-GB operation.
            </>
          ) : (
            <>
              Remove the <strong className="text-fg">{pendingDelete?.name}</strong> snap? It can be
              reinstalled at any time with a single command.
            </>
          )
        }
        confirmLabel={pendingDelete?.kind === 'model' ? 'Delete model' : 'Delete snapshot'}
        onConfirm={handleConfirmDelete}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
