import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginScreen from '../../components/auth/LoginScreen';
import type { AuthContextValue } from '../../hooks/use-auth';
import { AuthContext } from '../../hooks/use-auth';
import { SettingsContext } from '../../hooks/use-settings';

const updateSettings = vi.fn();

const defaultSettings = {
  settings: {
    theme: 'system' as const,
    apiUrl: 'https://api.revealui.com',
    pollingIntervalMs: 30_000,
    localMode: false,
  },
  updateSettings,
  resetSettings: vi.fn(),
};

const defaultAuth: AuthContextValue = {
  step: 'email',
  user: null,
  tokenExpiresAt: null,
  loading: false,
  error: null,
  sendOtp: vi.fn().mockResolvedValue(true),
  submitOtp: vi.fn().mockResolvedValue(true),
  signOut: vi.fn().mockResolvedValue(undefined),
  recheck: vi.fn().mockResolvedValue(undefined),
  getToken: vi.fn().mockReturnValue(null),
};

function renderGate(auth: Partial<AuthContextValue> = {}) {
  return render(
    <SettingsContext.Provider value={defaultSettings}>
      <AuthContext.Provider value={{ ...defaultAuth, ...auth }}>
        <LoginScreen />
      </AuthContext.Provider>
    </SettingsContext.Provider>,
  );
}

describe('LoginScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leads with local work, not a cloud login wall', () => {
    renderGate();

    expect(screen.getByText('RevDev')).toBeInTheDocument();
    expect(screen.getByText(/start locally without an account/)).toBeInTheDocument();
    expect(screen.getByText('Work on this machine')).toBeInTheDocument();
    expect(screen.getByText('Sign in with email')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByText(/Connecting to/)).not.toBeInTheDocument();
  });

  it('starts local mode from the primary action', () => {
    renderGate();

    fireEvent.click(screen.getByText('Work on this machine'));
    expect(updateSettings).toHaveBeenCalledWith({ localMode: true });
  });

  it('reveals email sign-in only after that path is chosen', () => {
    renderGate();

    fireEvent.click(screen.getByText('Sign in with email'));
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByText('Send verification code')).toBeInTheDocument();
    expect(screen.getByText(/Sign-in contacts https:\/\/api.revealui.com/)).toBeInTheDocument();
  });

  it('explains an empty email submit instead of doing nothing', () => {
    renderGate();

    fireEvent.click(screen.getByText('Sign in with email'));
    const form = screen.getByText('Send verification code').closest('form');
    if (!form) throw new Error('missing email form');
    fireEvent.submit(form);

    expect(screen.getByText('Enter the email that should receive the code.')).toBeInTheDocument();
    expect(defaultAuth.sendOtp).not.toHaveBeenCalled();
  });
});
