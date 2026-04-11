import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

vi.mock('../../hooks/use-tunnel', () => ({
  useTunnel: vi.fn().mockReturnValue({
    status: null,
    loading: false,
    error: null,
    toggling: false,
    up: vi.fn(),
    down: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(),
}));

vi.mock('../../lib/invoke', () => ({
  vaultInit: vi.fn(),
  vaultIsInitialized: vi.fn().mockResolvedValue(true),
}));

import SetupWizard from '../../components/setup/SetupWizard';

describe('SetupWizard', () => {
  it('renders "Setup RevealUI Studio" title', () => {
    render(<SetupWizard onClose={vi.fn()} />);
    expect(screen.getByText('Setup RevealUI Studio')).toBeInTheDocument();
  });

  it('renders Skip button', () => {
    render(<SetupWizard onClose={vi.fn()} />);
    expect(screen.getByText('Skip')).toBeInTheDocument();
  });

  it('renders Complete Setup button', () => {
    render(<SetupWizard onClose={vi.fn()} />);
    expect(screen.getByText('Complete Setup')).toBeInTheDocument();
  });

  it('renders all setup rows', () => {
    render(<SetupWizard onClose={vi.fn()} />);
    expect(screen.getByText('WSL')).toBeInTheDocument();
    expect(screen.getByText('Nix')).toBeInTheDocument();
    expect(screen.getByText('DevPod')).toBeInTheDocument();
    expect(screen.getByText('Git Identity')).toBeInTheDocument();
    expect(screen.getByText('Vault')).toBeInTheDocument();
    expect(screen.getByText('Tailscale')).toBeInTheDocument();
    expect(screen.getByText('Project Setup')).toBeInTheDocument();
  });

  it('enables Complete Setup when all checks pass', () => {
    render(<SetupWizard onClose={vi.fn()} />);
    const completeButton = screen.getByText('Complete Setup').closest('button');
    expect(completeButton).not.toBeDisabled();
  });
});
