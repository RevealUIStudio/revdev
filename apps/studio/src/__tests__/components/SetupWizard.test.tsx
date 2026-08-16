import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE: vitest hoists vi.mock above all imports/consts, so the factory must not
// reference outer variables — the status object is inlined here on purpose.
vi.mock('../../hooks/use-setup', () => ({
  useSetup: vi.fn().mockReturnValue({
    status: {
      wsl_running: true,
      nix_installed: true,
      devbox_mounted: true,
      git_name: 'RevealUI Studio',
      git_email: 'founder@revealui.com',
    },
    loading: false,
    error: null,
    gitName: 'RevealUI Studio',
    gitEmail: 'founder@revealui.com',
    saving: false,
    mounting: false,
    refresh: vi.fn(),
    saveGitIdentity: vi.fn(),
    doMount: vi.fn(),
    setGitName: vi.fn(),
    setGitEmail: vi.fn(),
  }),
  markSetupComplete: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(),
}));

vi.mock('../../lib/invoke', () => ({
  vaultInit: vi.fn(),
  vaultIsInitialized: vi.fn().mockResolvedValue(true),
  daemonSetup: vi.fn().mockResolvedValue('ok'),
  invokeErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import SetupWizard from '../../components/setup/SetupWizard';
import { markSetupComplete, useSetup } from '../../hooks/use-setup';
import { daemonSetup } from '../../lib/invoke';

function renderWizard(overrides?: { onComplete?: () => void; onDismiss?: () => void }) {
  const onComplete = overrides?.onComplete ?? vi.fn();
  const onDismiss = overrides?.onDismiss ?? vi.fn();
  render(<SetupWizard onComplete={onComplete} onDismiss={onDismiss} />);
  return { onComplete, onDismiss };
}

describe('SetupWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(daemonSetup).mockResolvedValue('ok');
  });

  it('renders "Setup RevealUI Studio" title', () => {
    renderWizard();
    expect(screen.getByText('Setup RevealUI Studio')).toBeInTheDocument();
    expect(screen.getByText(/Agent Approvals live under Agent in the sidebar/)).toBeInTheDocument();
  });

  it('renders Skip button', () => {
    renderWizard();
    expect(screen.getByText('Skip')).toBeInTheDocument();
  });

  it('renders Complete Setup button', () => {
    renderWizard();
    expect(screen.getByText('Complete Setup')).toBeInTheDocument();
  });

  it('renders all setup rows', () => {
    renderWizard();
    expect(screen.getByText('WSL')).toBeInTheDocument();
    expect(screen.getByText('Nix')).toBeInTheDocument();
    expect(screen.getByText('DevPod')).toBeInTheDocument();
    expect(screen.getByText('Git Identity')).toBeInTheDocument();
    expect(screen.getByText('Vault')).toBeInTheDocument();
    expect(screen.getByText('Project Setup')).toBeInTheDocument();
  });

  it('enables Complete Setup when all checks pass', () => {
    renderWizard();
    const completeButton = screen.getByText('Complete Setup').closest('button');
    expect(completeButton).not.toBeDisabled();
  });

  it('completing setup installs the WSL relay then marks complete', async () => {
    const { onComplete, onDismiss } = renderWizard();
    fireEvent.click(screen.getByText('Complete Setup'));
    await waitFor(() => {
      expect(daemonSetup).toHaveBeenCalledTimes(1);
      expect(markSetupComplete).toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not mark complete when relay install fails', async () => {
    vi.mocked(daemonSetup).mockRejectedValueOnce(new Error('wslpath failed'));
    const { onComplete } = renderWizard();
    fireEvent.click(screen.getByText('Complete Setup'));
    expect(await screen.findByText('wslpath failed')).toBeInTheDocument();
    expect(markSetupComplete).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('skipping with all checks passing dismisses directly without a confirm', () => {
    const { onComplete, onDismiss } = renderWizard();
    fireEvent.click(screen.getByText('Skip'));
    // allDone === true → no confirmation gate, dismiss is immediate
    expect(screen.queryByText('Dismiss setup?')).not.toBeInTheDocument();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('skipping an unfinished setup requires confirmation and never marks complete', () => {
    // Override the mock for this render only: setup is NOT finished.
    vi.mocked(useSetup).mockReturnValueOnce({
      status: {
        wsl_running: false,
        nix_installed: true,
        devbox_mounted: true,
        git_name: 'RevealUI Studio',
        git_email: 'founder@revealui.com',
      },
      loading: false,
      error: null,
      gitName: 'RevealUI Studio',
      gitEmail: 'founder@revealui.com',
      saving: false,
      mounting: false,
      refresh: vi.fn(),
      saveGitIdentity: vi.fn(),
      doMount: vi.fn(),
      setGitName: vi.fn(),
      setGitEmail: vi.fn(),
    } as unknown as ReturnType<typeof useSetup>);

    const { onComplete, onDismiss } = renderWizard();
    fireEvent.click(screen.getByText('Skip'));

    // The dismiss is gated behind the confirm dialog; onDismiss has not fired yet.
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByText('Dismiss setup?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss setup' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(markSetupComplete).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
