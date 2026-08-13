import { useCallback, useEffect, useState } from 'react';
import { getConfig, setConfig } from '../lib/config';
import type { StudioConfig } from '../types';

interface UseConfigReturn {
  config: StudioConfig | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  updateConfig: (updates: Partial<StudioConfig>) => Promise<void>;
  setIntent: (intent: 'deploy' | 'develop') => Promise<void>;
}

export function useConfig(): UseConfigReturn {
  const [config, setConfigState] = useState<StudioConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConfigState(await getConfig());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload().catch(() => undefined);
  }, [reload]);

  const updateConfig = async (updates: Partial<StudioConfig>) => {
    if (!config) return;
    const updated = { ...config, ...updates };
    try {
      await setConfig(updated);
      setConfigState(updated);
    } catch (e) {
      setError(String(e));
    }
  };

  const setIntent = async (intent: 'deploy' | 'develop') => {
    await updateConfig({ intent });
  };

  return { config, loading, error, reload, updateConfig, setIntent };
}
