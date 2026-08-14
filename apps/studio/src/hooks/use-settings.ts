import { createContext, use, useState } from 'react';

export type Theme = 'dark' | 'light' | 'system';

export interface StudioSettings {
  theme: Theme;
  apiUrl: string;
  pollingIntervalMs: number;
  /**
   * Local mode: skip API sign-in and use Studio's local, self-contained
   * tools (terminal, shell, git) offline. Off by default. Account and
   * API-backed features stay disabled until you sign in.
   */
  localMode: boolean;
}

const DEFAULT_API_URL = import.meta.env.DEV ? 'http://localhost:3004' : 'https://api.revealui.com';

const DEFAULT_SETTINGS: StudioSettings = {
  theme: 'system',
  apiUrl: DEFAULT_API_URL,
  pollingIntervalMs: 30_000,
  localMode: false,
};

const STORAGE_KEY = 'revealui-studio-settings';

function loadSettings(): StudioSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SETTINGS };
    const obj = parsed as Record<string, unknown>;
    return {
      theme:
        obj.theme === 'dark' || obj.theme === 'light' || obj.theme === 'system'
          ? obj.theme
          : DEFAULT_SETTINGS.theme,
      apiUrl:
        typeof obj.apiUrl === 'string' && obj.apiUrl.length > 0
          ? obj.apiUrl
          : DEFAULT_SETTINGS.apiUrl,
      pollingIntervalMs:
        typeof obj.pollingIntervalMs === 'number' && obj.pollingIntervalMs >= 1_000
          ? obj.pollingIntervalMs
          : DEFAULT_SETTINGS.pollingIntervalMs,
      localMode: typeof obj.localMode === 'boolean' ? obj.localMode : DEFAULT_SETTINGS.localMode,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persistSettings(settings: StudioSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable (SSR or quota exceeded)
  }
}

export interface SettingsContextValue {
  settings: StudioSettings;
  updateSettings: (patch: Partial<StudioSettings>) => void;
  resetSettings: () => void;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettingsContext(): SettingsContextValue {
  const ctx = use(SettingsContext);
  if (!ctx) throw new Error('useSettingsContext must be used inside SettingsProvider');
  return ctx;
}

export function useSettings(): SettingsContextValue {
  const [settings, setSettings] = useState<StudioSettings>(loadSettings);

  function updateSettings(patch: Partial<StudioSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      persistSettings(next);
      return next;
    });
  }

  function resetSettings() {
    persistSettings(DEFAULT_SETTINGS);
    setSettings({ ...DEFAULT_SETTINGS });
  }

  return { settings, updateSettings, resetSettings };
}
