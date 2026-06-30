import { useCallback, useEffect, useState } from 'react';
import {
  vaultDelete,
  vaultGet,
  vaultInit,
  vaultIsInitialized,
  vaultList,
  vaultSearch,
  vaultSet,
} from '../lib/invoke';
import type { SecretInfo } from '../types';

interface VaultState {
  initialized: boolean;
  secrets: SecretInfo[];
  selectedPath: string | null;
  selectedValue: string | null;
  loading: boolean;
  valueLoading: boolean;
  error: string | null;
  searchQuery: string;
  activeNamespace: string | null;
}

export function useVault() {
  const [state, setState] = useState<VaultState>({
    initialized: false,
    secrets: [],
    selectedPath: null,
    selectedValue: null,
    loading: true,
    valueLoading: false,
    error: null,
    searchQuery: '',
    activeNamespace: null,
  });

  const init = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const isInit = await vaultIsInitialized();
      if (!isInit) {
        await vaultInit();
      }
      const secrets = await vaultList();
      setState((prev) => ({ ...prev, initialized: true, secrets, loading: false }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  useEffect(() => {
    init();
  }, [init]);

  const refresh = useCallback(async () => {
    if (!state.initialized) return;
    try {
      const secrets =
        state.searchQuery.trim() !== ''
          ? await vaultSearch(state.searchQuery)
          : await vaultList(state.activeNamespace ?? undefined);
      setState((prev) => ({ ...prev, secrets }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [state.initialized, state.searchQuery, state.activeNamespace]);

  const initStore = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      await vaultInit();
      const secrets = await vaultList();
      setState((prev) => ({ ...prev, initialized: true, secrets, loading: false }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  const selectSecret = useCallback(async (path: string) => {
    setState((prev) => ({ ...prev, selectedPath: path, valueLoading: true, selectedValue: null }));
    try {
      const value = await vaultGet(path);
      setState((prev) => ({ ...prev, selectedValue: value, valueLoading: false }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        valueLoading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  // Return a success boolean so a caller (e.g. CreateSecretDialog) can keep its
  // form open + preserve input on failure rather than closing on a resolved
  // promise that actually failed (the #200 resolve-on-failure finding).
  const createSecret = useCallback(
    async (path: string, value: string): Promise<boolean> => {
      setState((prev) => ({ ...prev, error: null }));
      try {
        await vaultSet(path, value, false);
        await refresh();
        return true;
      } catch (err) {
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
        }));
        return false;
      }
    },
    [refresh],
  );

  const deleteSecret = useCallback(
    async (path: string): Promise<boolean> => {
      setState((prev) => ({ ...prev, error: null }));
      try {
        await vaultDelete(path);
        setState((prev) => ({
          ...prev,
          selectedPath: prev.selectedPath === path ? null : prev.selectedPath,
          selectedValue: prev.selectedPath === path ? null : prev.selectedValue,
        }));
        await refresh();
        return true;
      } catch (err) {
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
        }));
        return false;
      }
    },
    [refresh],
  );

  const setSearchQuery = useCallback((query: string) => {
    setState((prev) => ({ ...prev, searchQuery: query }));
  }, []);

  const setActiveNamespace = useCallback((ns: string | null) => {
    setState((prev) => ({ ...prev, activeNamespace: ns, selectedPath: null, selectedValue: null }));
  }, []);

  // Re-fetch when search or namespace changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is stable; re-running on its identity change would cause a loop
  useEffect(() => {
    if (state.initialized) {
      refresh();
    }
  }, [state.searchQuery, state.activeNamespace, state.initialized]);

  const namespaces = [...new Set(state.secrets.map((s) => s.namespace))].sort();

  return {
    ...state,
    namespaces,
    initStore,
    selectSecret,
    createSecret,
    deleteSecret,
    setSearchQuery,
    setActiveNamespace,
    refresh,
  };
}
