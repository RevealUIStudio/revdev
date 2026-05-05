import { useCallback, useRef, useState } from 'react';
import {
  inferenceOllamaDelete,
  inferenceOllamaModels,
  inferenceOllamaPull,
  inferenceOllamaStart,
  inferenceOllamaStatus,
  inferenceOllamaStop,
  inferenceSnapInstall,
  inferenceSnapList,
  inferenceSnapRemove,
} from '../lib/invoke';
import type { OllamaModel, OllamaStatus, SnapModel } from '../types';
import { usePollingFetch } from './use-polling-fetch';

interface InferenceSnapshot {
  ollama: OllamaStatus;
  models: OllamaModel[];
  snaps: SnapModel[];
}

export function useInference() {
  const lastResultRef = useRef<InferenceSnapshot | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [installingSnap, setInstallingSnap] = useState<string | null>(null);

  const fetchFn = useCallback(async (_signal: AbortSignal): Promise<InferenceSnapshot> => {
    if (document.hidden && lastResultRef.current !== null) {
      return lastResultRef.current;
    }
    const [ollamaResult, snapList] = await Promise.all([
      inferenceOllamaStatus(),
      inferenceSnapList(),
    ]);
    const modelList = ollamaResult.running ? await inferenceOllamaModels() : [];
    const snapshot: InferenceSnapshot = {
      ollama: ollamaResult,
      models: modelList,
      snaps: snapList,
    };
    lastResultRef.current = snapshot;
    return snapshot;
  }, []);

  const { data, error: pollError, loading, refresh } = usePollingFetch(fetchFn, 30_000);

  const ollama = data?.ollama ?? null;
  const models = data?.models ?? [];
  const snaps = data?.snaps ?? [];
  const error = actionError ?? pollError?.message ?? null;

  async function startOllama(): Promise<void> {
    setActionError(null);
    try {
      await inferenceOllamaStart();
      await new Promise((r) => setTimeout(r, 2000));
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function stopOllama(): Promise<void> {
    setActionError(null);
    try {
      await inferenceOllamaStop();
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function pullModel(name: string): Promise<void> {
    setActionError(null);
    setPulling(true);
    try {
      const result = await inferenceOllamaPull(name);
      if (!result.success) {
        setActionError(result.message);
      }
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPulling(false);
    }
  }

  async function deleteModel(name: string): Promise<void> {
    setActionError(null);
    try {
      await inferenceOllamaDelete(name);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function installSnap(snapName: string): Promise<void> {
    setActionError(null);
    setInstallingSnap(snapName);
    try {
      const result = await inferenceSnapInstall(snapName);
      if (!result.success) {
        setActionError(result.message);
      }
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingSnap(null);
    }
  }

  async function removeSnap(snapName: string): Promise<void> {
    setActionError(null);
    try {
      await inferenceSnapRemove(snapName);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return {
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
  };
}
