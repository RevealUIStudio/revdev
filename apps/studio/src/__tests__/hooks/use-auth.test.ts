import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../hooks/use-auth';

// Local mode must never touch the API or the vault. Mock both so any call
// is observable and can be asserted against.
vi.mock('../../lib/auth-api', () => ({
  checkStatus: vi.fn(),
  linkDevice: vi.fn(),
  refreshToken: vi.fn(),
  revokeToken: vi.fn(),
  verifyDevice: vi.fn(),
}));

vi.mock('../../lib/invoke', () => ({
  vaultGet: vi.fn(),
  vaultSet: vi.fn(),
}));

const { checkStatus } = await import('../../lib/auth-api');
const { vaultGet } = await import('../../lib/invoke');

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('useAuth — local mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('authenticates a synthetic local user without calling the API or vault', async () => {
    const { result } = renderHook(() => useAuth('https://api.example.com', true));

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.step).toBe('authenticated');
    expect(result.current.user?.email).toBe('local@localhost');
    expect(result.current.user?.role).toBe('local');
    expect(result.current.getToken()).toBeNull();
    expect(vi.mocked(checkStatus)).not.toHaveBeenCalled();
    expect(vi.mocked(vaultGet)).not.toHaveBeenCalled();
  });

  it('falls back to the email step when local mode is off and no token is stored', async () => {
    vi.mocked(vaultGet).mockRejectedValue(new Error('vault unavailable'));

    const { result } = renderHook(() => useAuth('https://api.example.com', false));

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.step).toBe('email');
    expect(result.current.user).toBeNull();
    expect(vi.mocked(checkStatus)).not.toHaveBeenCalled();
  });
});
