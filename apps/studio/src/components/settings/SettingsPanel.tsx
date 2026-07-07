import { useEffect, useState } from 'react';
import type { Theme } from '../../hooks/use-settings';
import { useSettingsContext } from '../../hooks/use-settings';
import Card from '../ui/Card';
import PanelHeader from '../ui/PanelHeader';

type SettingsTab = 'appearance' | 'connection' | 'about';

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'appearance', label: 'Appearance' },
  { key: 'connection', label: 'Connection' },
  { key: 'about', label: 'About' },
];

const POLLING_OPTIONS = [
  { label: '10s', value: 10_000 },
  { label: '30s', value: 30_000 },
  { label: '60s', value: 60_000 },
  { label: '5m', value: 300_000 },
];

const LOCAL_MODE_OPTIONS = [
  { label: 'On', value: true },
  { label: 'Off', value: false },
];

export default function SettingsPanel() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');
  const [appVersion, setAppVersion] = useState('dev');
  const { settings, updateSettings, resetSettings } = useSettingsContext();

  useEffect(() => {
    let cancelled = false;
    async function loadVersion() {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        const version = await getVersion();
        if (!cancelled) {
          setAppVersion(version);
        }
      } catch {
        // Not running in Tauri context — keep "dev" default
      }
    }
    void loadVersion();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <PanelHeader title="Settings" />

      {/* Tab bar */}
      <div className="flex gap-1 rounded-lg bg-surface-1 p-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.key ? 'bg-surface-2 text-fg' : 'text-fg-subtle hover:text-fg-muted'
            }`}
          >
            {tab.label}
            {tab.key === 'connection' && settings.localMode && (
              <span className="ml-1.5 inline-block rounded bg-accent px-1 py-0.5 text-[10px] font-semibold leading-none text-fg">
                LOCAL
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'appearance' && (
        <Card header={<h2 className="text-sm font-semibold text-fg">Appearance</h2>}>
          <div className="flex flex-col gap-3">
            <span className="text-sm text-fg-muted">Theme</span>
            <div className="flex gap-2">
              {(['dark', 'light', 'system'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => updateSettings({ theme: option as Theme })}
                  className={`rounded-md px-4 py-2 text-sm capitalize transition-colors ${
                    settings.theme === option
                      ? 'bg-brand text-on-brand'
                      : 'bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        </Card>
      )}

      {activeTab === 'connection' && (
        <Card header={<h2 className="text-sm font-semibold text-fg">Connection</h2>}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="settings-api-url" className="text-sm text-fg-muted">
                API URL
              </label>
              <input
                id="settings-api-url"
                type="text"
                value={settings.apiUrl}
                onChange={(e) => updateSettings({ apiUrl: e.target.value })}
                className="rounded-md border border-edge bg-surface-2 px-3 py-2 text-sm text-fg-muted focus:border-edge focus:outline-none"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm text-fg-muted">Polling interval</span>
              <div className="flex gap-2">
                {POLLING_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => updateSettings({ pollingIntervalMs: opt.value })}
                    className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                      settings.pollingIntervalMs === opt.value
                        ? 'bg-brand text-on-brand'
                        : 'bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-sm text-fg-muted">Local mode</span>
                {settings.localMode && (
                  <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-fg">
                    Active
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {LOCAL_MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => updateSettings({ localMode: opt.value })}
                    className={`rounded-md px-4 py-2 text-sm transition-colors ${
                      settings.localMode === opt.value
                        ? 'bg-brand text-on-brand'
                        : 'bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-fg-subtle">
                Skip sign-in and use local tools (terminal, shell, git) offline. Account and
                API-backed features stay disabled until you sign in.
              </span>
            </div>
          </div>
        </Card>
      )}

      {activeTab === 'about' && (
        <Card header={<h2 className="text-sm font-semibold text-fg">About</h2>}>
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-fg-muted">Version</span>
              <span className="text-sm text-fg-muted">{appVersion}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-fg-muted">Documentation</span>
              <span className="text-sm text-fg-subtle">docs.revealui.com</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-fg-muted">GitHub</span>
              <span className="text-sm text-fg-subtle">github.com/RevealUIStudio/revealui</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-fg-muted">Community</span>
              <span className="text-sm text-fg-subtle">revnation.discourse.group</span>
            </div>
            <div className="pt-2 border-t border-edge">
              <button
                type="button"
                onClick={resetSettings}
                className="text-sm text-fg-subtle hover:text-fg-muted transition-colors"
              >
                Reset all settings to defaults
              </button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
