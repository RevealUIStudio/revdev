import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../hooks/use-auth';

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

const { revokeToken, checkStatus } = await import('../../lib/auth-api');
const { vaultGet, vaultSet } = await import('../../lib/invoke');

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('useAuth — signOut order (HC13c)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(vaultGet).mockResolvedValue('stored-token');
    vi.mocked(vaultSet).mockResolvedValue(undefined);
    vi.mocked(checkStatus).mockResolvedValue({
      authenticated: true,
      user: { id: '1', email: 'a@b.c', name: null, role: 'user' },
      tokenExpiresAt: '2099-01-01T00:00:00Z',
    });
    vi.mocked(revokeToken).mockImplementation(async () => {
      // Delay so we can observe intermediate state before revoke completes.
      await new Promise((r) => setTimeout(r, 20));
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('sets signingOut, clears step/token before revokeToken', async () => {
    const { result } = renderHook(() => useAuth('https://api.example.com', false));

    await act(async () => {
      await flushPromises();
    });
    expect(result.current.step).toBe('authenticated');
    expect(result.current.getToken()).toBe('stored-token');

    const observed: {
      signingOutRef: boolean;
      stepRef: string;
      token: string | null;
    }[] = [];

    vi.mocked(revokeToken).mockImplementation(async () => {
      observed.push({
        signingOutRef: result.current.getSigningOut(),
        stepRef: result.current.getStep(),
        token: result.current.getToken(),
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      await result.current.signOut('https://api.example.com');
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({
      signingOutRef: true,
      stepRef: 'email',
      token: null,
    });
    expect(result.current.signingOut).toBe(false);
    expect(result.current.getSigningOut()).toBe(false);
    expect(result.current.step).toBe('email');
    expect(result.current.getToken()).toBeNull();
  });
});
