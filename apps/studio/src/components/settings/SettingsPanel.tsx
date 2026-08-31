import { useEffect, useState } from 'react';
import type { Theme } from '../../hooks/use-settings';
import { useSettingsContext } from '../../hooks/use-settings';
import { getDaemonUrl, pairWithDaemon, setDaemonToken, setDaemonUrl } from '../../lib/invoke';
import Button from '../adapters/Button';
import Card from '../adapters/Card';
import Input from '../adapters/Input';
import PanelHeader from '../adapters/PanelHeader';

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
          <Button
            key={tab.key}
            type="button"
            variant="ghost"
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
          </Button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'appearance' && (
        <Card header={<h2 className="text-sm font-semibold text-fg">Appearance</h2>}>
          <div className="flex flex-col gap-3">
            <span className="text-sm text-fg-muted">Theme</span>
            <div className="flex gap-2">
              {(['dark', 'light', 'system'] as const).map((option) => (
                <Button
                  key={option}
                  type="button"
                  variant={settings.theme === option ? 'primary' : 'ghost'}
                  onClick={() => updateSettings({ theme: option as Theme })}
                  className={`rounded-md px-4 py-2 text-sm capitalize transition-colors ${
                    settings.theme === option
                      ? 'bg-brand text-on-brand'
                      : 'bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg'
                  }`}
                >
                  {option}
                </Button>
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
              <Input
                id="settings-api-url"
                type="text"
                value={settings.apiUrl}
                onChange={(e) => updateSettings({ apiUrl: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm text-fg-muted">Polling interval</span>
              <div className="flex gap-2">
                {POLLING_OPTIONS.map((opt) => (
                  <Button
                    key={opt.value}
                    type="button"
                    variant={settings.pollingIntervalMs === opt.value ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => updateSettings({ pollingIntervalMs: opt.value })}
                    className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                      settings.pollingIntervalMs === opt.value
                        ? 'bg-brand text-on-brand'
                        : 'bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg'
                    }`}
                  >
                    {opt.label}
                  </Button>
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
                  <Button
                    key={opt.label}
                    type="button"
                    variant={settings.localMode === opt.value ? 'primary' : 'ghost'}
                    onClick={() => updateSettings({ localMode: opt.value })}
                    className={`rounded-md px-4 py-2 text-sm transition-colors ${
                      settings.localMode === opt.value
                        ? 'bg-brand text-on-brand'
                        : 'bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg'
                    }`}
                  >
                    {opt.label}
                  </Button>
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

      {activeTab === 'connection' && <RemoteDaemonPairing />}

      {activeTab === 'about' && (
        <Card header={<h2 className="text-sm font-semibold text-fg">About</h2>}>
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-fg-muted">App</span>
              <span className="text-sm text-fg-muted">RevDev</span>
            </div>
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={resetSettings}
                className="h-auto p-0 text-sm text-fg-subtle hover:text-fg-muted transition-colors"
              >
                Reset all settings to defaults
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * Remote-daemon pairing (GAP-421 daemon-ownership ADR, wire path §5). Pairing
 * is an explicit operator action only — the daemon URL and pairing secret are
 * never submitted automatically; nothing is sent until "Pair" is clicked.
 */
function RemoteDaemonPairing() {
  const [daemonUrl, setDaemonUrlInput] = useState('');
  const [secret, setSecret] = useState('');
  const [pairedUrl, setPairedUrl] = useState<string | null>(() => getDaemonUrl());
  const [status, setStatus] = useState<{
    kind: 'idle' | 'pairing' | 'error' | 'success';
    message?: string;
  }>({
    kind: 'idle',
  });

  async function handlePair() {
    if (!daemonUrl.trim() || !secret.trim()) {
      setStatus({ kind: 'error', message: 'Daemon URL and pairing secret are both required.' });
      return;
    }
    setStatus({ kind: 'pairing' });
    try {
      await pairWithDaemon({ daemonUrl: daemonUrl.trim(), secret: secret.trim(), label: 'studio' });
      setPairedUrl(daemonUrl.trim());
      setSecret('');
      setStatus({
        kind: 'success',
        message: 'Paired. This daemon is now the active remote connection.',
      });
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Pairing failed.' });
    }
  }

  function handleForget() {
    setDaemonUrl(null);
    setDaemonToken(null);
    setPairedUrl(null);
    setStatus({ kind: 'idle' });
  }

  return (
    <Card header={<h2 className="text-sm font-semibold text-fg">Remote daemon</h2>}>
      <div className="flex flex-col gap-4">
        {pairedUrl && (
          <div className="flex items-center justify-between rounded-md bg-surface-2 px-3 py-2">
            <span className="text-sm text-fg-muted">
              Paired with <span className="text-fg">{pairedUrl}</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleForget}
              className="h-auto p-0 text-sm text-fg-subtle hover:text-fg-muted transition-colors"
            >
              Forget
            </Button>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <label htmlFor="daemon-pair-url" className="text-sm text-fg-muted">
            Daemon URL
          </label>
          <Input
            id="daemon-pair-url"
            type="text"
            placeholder="http://127.0.0.1:7890"
            value={daemonUrl}
            onChange={(e) => setDaemonUrlInput(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="daemon-pair-secret" className="text-sm text-fg-muted">
            Pairing secret
          </label>
          <Input
            id="daemon-pair-secret"
            type="password"
            placeholder="contents of the daemon's gateway-pairing-secret file"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <span className="text-xs text-fg-subtle">
            Read from the 0600 secret file the daemon printed at boot. Never sent on the wire — used
            only to sign the pairing challenge locally.
          </span>
        </div>
        <Button
          type="button"
          variant="primary"
          onClick={() => void handlePair()}
          disabled={status.kind === 'pairing'}
          loading={status.kind === 'pairing'}
          className="self-start"
        >
          {status.kind === 'pairing' ? 'Pairing…' : 'Pair'}
        </Button>
        {status.message && (
          <span className={`text-xs ${status.kind === 'error' ? 'text-error' : 'text-fg-subtle'}`}>
            {status.message}
          </span>
        )}
      </div>
    </Card>
  );
}
