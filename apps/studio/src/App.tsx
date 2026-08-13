import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';
import Button from './components/adapters/Button';
import AgentPanel from './components/agent/AgentPanel';
import LoginScreen from './components/auth/LoginScreen';
import Dashboard from './components/dashboard/Dashboard';
import DeployDashboard from './components/dashboard/DeployDashboard';
import DeployWizard from './components/deploy/DeployWizard';
import CodeEditor from './components/editor/CodeEditor';
import FleetMapPanel from './components/fleet/FleetMapPanel';
import TileGallery from './components/gallery/TileGallery';
import GitPanel from './components/git/GitPanel';
import InferencePanel from './components/inference/InferencePanel';
import InfrastructurePanel from './components/infrastructure/InfrastructurePanel';
import IntentScreen from './components/intent/IntentScreen';
import AppShell from './components/layout/AppShell';
import SettingsPanel from './components/settings/SettingsPanel';
import SetupPage from './components/setup/SetupPage';
import SetupWizard from './components/setup/SetupWizard';
import SyncPanel from './components/sync/SyncPanel';
import TerminalPanel from './components/terminal/TerminalPanel';
import VaultPanel from './components/vault/VaultPanel';
import { AuthContext, useAuth } from './hooks/use-auth';
import { useConfig } from './hooks/use-config';
import { SettingsContext, useSettings, useSettingsContext } from './hooks/use-settings';
import type { Page } from './types';

interface EditorTarget {
  repoPath: string;
  filePath: string;
}

export default function App() {
  const settingsValue = useSettings();

  return (
    <SettingsContext.Provider value={settingsValue}>
      <AuthGatedApp />
    </SettingsContext.Provider>
  );
}

function AuthGatedApp() {
  const { settings } = useSettingsContext();
  const auth = useAuth(settings.apiUrl, settings.localMode);

  useEffect(() => {
    const el = document.documentElement;
    if (settings.theme === 'system') {
      el.removeAttribute('data-theme');
    } else {
      el.setAttribute('data-theme', settings.theme);
    }
  }, [settings.theme]);

  return (
    <AuthContext.Provider value={auth}>
      {auth.loading && auth.step === 'idle' ? (
        <div className="flex h-screen items-center justify-center bg-surface-0">
          <div className="text-fg-muted">Loading...</div>
        </div>
      ) : auth.step !== 'authenticated' ? (
        <LoginScreen />
      ) : (
        <MainApp />
      )}
    </AuthContext.Provider>
  );
}

function MainApp() {
  const [page, setPage] = useState<Page>('dashboard');
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  // Session-level dismiss of the setup wizard. Distinct from `config.setupComplete`:
  // dismissing only hides the wizard for this launch (it reappears next start),
  // whereas completing setup persists. Conflating the two used to mark setup
  // permanently complete on any close gesture (UX-durability audit, Theme 3).
  const [wizardDismissed, setWizardDismissed] = useState(false);
  const { config, loading, error, reload, setIntent, updateConfig } = useConfig();

  // Listen for tray-click navigation events from Rust
  useEffect(() => {
    const unlisten = listen<string>('navigate', (event) => {
      const target = event.payload as Page;
      setPage(target);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  function openInEditor(repoPath: string, filePath: string) {
    setEditorTarget({ repoPath, filePath });
    setPage('editor');
  }

  if (loading) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 bg-surface-0">
        <div className="text-fg-muted">Loading your Studio setup</div>
        <p className="text-sm text-fg-subtle">Reading the local config for this machine.</p>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-0">
        <div className="w-full max-w-sm space-y-3 px-6 text-center">
          <h1 className="text-lg font-semibold text-fg">Studio could not read its local config</h1>
          <p className="text-sm text-fg-muted">
            {error ?? 'The config file is missing or unreadable.'}
          </p>
          <Button
            variant="primary"
            onClick={() => {
              reload().catch(() => undefined);
            }}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (!config.intent) {
    return (
      <IntentScreen
        onSelect={async (intent) => {
          await setIntent(intent);
        }}
      />
    );
  }

  if (config.intent === 'deploy' && !config.setupComplete) {
    return (
      <DeployWizard
        onComplete={async () => {
          await updateConfig({ setupComplete: true });
        }}
      />
    );
  }

  if (config.intent === 'develop' && !config.setupComplete) {
    return (
      <>
        <AppShell
          currentPage={page}
          onNavigate={setPage}
          padless={page === 'git' || page === 'editor'}
        >
          {page === 'dashboard' ? <Dashboard /> : null}
          {page === 'fleet' ? <FleetMapPanel /> : null}
          {page === 'gallery' ? <TileGallery /> : null}
          {page === 'vault' ? <VaultPanel /> : null}
          {page === 'infrastructure' ? <InfrastructurePanel /> : null}
          {page === 'sync' ? <SyncPanel /> : null}
          {page === 'terminal' ? <TerminalPanel /> : null}
          {page === 'git' ? <GitPanel onOpenEditor={openInEditor} /> : null}
          {page === 'editor' && editorTarget ? (
            <CodeEditor
              repoPath={editorTarget.repoPath}
              filePath={editorTarget.filePath}
              onClose={() => setPage('git')}
            />
          ) : null}
          {page === 'editor' && !editorTarget ? (
            <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
              No file selected — open a file from the Git panel
            </div>
          ) : null}
          {page === 'agent' ? <AgentPanel /> : null}
          {page === 'setup' ? <SetupPage /> : null}
          {page === 'settings' ? <SettingsPanel /> : null}
        </AppShell>
        {!wizardDismissed && (
          <SetupWizard
            onComplete={() => {
              void updateConfig({ setupComplete: true });
            }}
            onDismiss={() => setWizardDismissed(true)}
          />
        )}
      </>
    );
  }

  // Setup complete — deploy intent shows deploy dashboard
  if (config.intent === 'deploy') {
    return (
      <AppShell currentPage={page} onNavigate={setPage}>
        {page === 'dashboard' ? <DeployDashboard /> : null}
        {page === 'setup' ? <SetupPage /> : null}
        {page === 'settings' ? <SettingsPanel /> : null}
      </AppShell>
    );
  }

  // Setup complete — develop intent shows full experience
  return (
    <AppShell currentPage={page} onNavigate={setPage} padless={page === 'git' || page === 'editor'}>
      {page === 'dashboard' ? <Dashboard /> : null}
      {page === 'fleet' ? <FleetMapPanel /> : null}
      {page === 'gallery' ? <TileGallery /> : null}
      {page === 'vault' ? <VaultPanel /> : null}
      {page === 'infrastructure' ? <InfrastructurePanel /> : null}
      {page === 'sync' ? <SyncPanel /> : null}
      {page === 'terminal' ? <TerminalPanel /> : null}
      {page === 'git' ? <GitPanel onOpenEditor={openInEditor} /> : null}
      {page === 'editor' && editorTarget ? (
        <CodeEditor
          repoPath={editorTarget.repoPath}
          filePath={editorTarget.filePath}
          onClose={() => setPage('git')}
        />
      ) : null}
      {page === 'editor' && !editorTarget ? (
        <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
          No file selected — open a file from the Git panel
        </div>
      ) : null}
      {page === 'agent' ? <AgentPanel /> : null}
      {page === 'inference' ? <InferencePanel /> : null}
      {page === 'setup' ? <SetupPage /> : null}
      {page === 'settings' ? <SettingsPanel /> : null}
    </AppShell>
  );
}
