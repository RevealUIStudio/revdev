import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WelcomeBanner from '../../components/dashboard/WelcomeBanner';
import { SettingsContext } from '../../hooks/use-settings';

function renderBanner(localMode: boolean) {
  return render(
    <SettingsContext.Provider
      value={{
        settings: {
          theme: 'system',
          apiUrl: 'http://localhost:3004',
          pollingIntervalMs: 30_000,
          localMode,
          licenseAutoProvision: false,
        },
        updateSettings: vi.fn(),
        resetSettings: vi.fn(),
      }}
    >
      <WelcomeBanner />
    </SettingsContext.Provider>,
  );
}

describe('WelcomeBanner', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('shows local next steps when local mode is on', () => {
    renderBanner(true);

    expect(screen.getByText('You are working on this machine')).toBeInTheDocument();
    expect(screen.getByText('Open Agent in the sidebar.')).toBeInTheDocument();
    expect(screen.getByText('Open the Approvals tab on the right.')).toBeInTheDocument();
  });

  it('keeps the account-mode welcome when local mode is off', () => {
    renderBanner(false);

    expect(screen.getByText('Your development workspace')).toBeInTheDocument();
    expect(screen.queryByText('You are working on this machine')).not.toBeInTheDocument();
  });
});
