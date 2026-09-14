import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../lib/http';
import { type LicenseProvisionDeps, runLicenseProvision } from '../../lib/license-provision';

vi.mock('../../lib/auth-api', () => ({
  checkStatus: vi.fn(),
  refreshToken: vi.fn(),
}));

vi.mock('../../lib/invoke', () => ({
  licenseEnvOverride: vi.fn(),
  licenseVerifyLocal: vi.fn(),
  licenseWriteManaged: vi.fn(),
  licenseWipeManaged: vi.fn(),
  vaultSet: vi.fn(),
  vaultDelete: vi.fn(),
  daemonRestart: vi.fn(),
}));

vi.mock('../../lib/http', async () => {
  const actual = await vi.importActual<typeof import('../../lib/http')>('../../lib/http');
  return {
    ...actual,
    httpRequest: vi.fn(),
  };
});

const { refreshToken } = await import('../../lib/auth-api');
const { httpRequest } = await import('../../lib/http');
const {
  daemonRestart,
  licenseEnvOverride,
  licenseVerifyLocal,
  licenseWipeManaged,
  licenseWriteManaged,
  vaultDelete,
  vaultSet,
} = await import('../../lib/invoke');

const JWT = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJ0ZXN0LWp0aSIsInRpZXIiOiJwcm8ifQ.sig';

function baseDeps(overrides: Partial<LicenseProvisionDeps> = {}): LicenseProvisionDeps {
  return {
    apiUrl: 'https://api.example.com',
    getToken: () => 'tok-1',
    getSigningOut: () => false,
    getStep: () => 'authenticated',
    localMode: false,
    licenseAutoProvision: true,
    ...overrides,
  };
}

describe('runLicenseProvision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(licenseEnvOverride).mockResolvedValue(false);
    vi.mocked(vaultSet).mockResolvedValue(undefined);
    vi.mocked(vaultDelete).mockResolvedValue(undefined);
    vi.mocked(daemonRestart).mockResolvedValue(1);
    vi.mocked(licenseWriteManaged).mockResolvedValue({ changed: true });
    vi.mocked(licenseWipeManaged).mockResolvedValue({ wiped: true });
    vi.mocked(licenseVerifyLocal).mockResolvedValue({ valid: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips when localMode is on', async () => {
    const outcome = await runLicenseProvision(baseDeps({ localMode: true }));
    expect(outcome).toEqual({ kind: 'skipped', reason: 'localMode' });
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('skips when licenseAutoProvision is false', async () => {
    const outcome = await runLicenseProvision(baseDeps({ licenseAutoProvision: false }));
    expect(outcome).toEqual({ kind: 'skipped', reason: 'licenseAutoProvision=false' });
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('skips when signingOut', async () => {
    const outcome = await runLicenseProvision(baseDeps({ getSigningOut: () => true }));
    expect(outcome.kind).toBe('skipped');
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it('does not wipe on HTTP 404 (flag off)', async () => {
    vi.mocked(httpRequest).mockRejectedValue(new HttpError('Not found', 'client', 404));
    const outcome = await runLicenseProvision(baseDeps());
    expect(outcome).toEqual({ kind: 'flag-off' });
    expect(licenseWipeManaged).not.toHaveBeenCalled();
    expect(vaultDelete).not.toHaveBeenCalled();
  });

  it('does not wipe on network / 5xx', async () => {
    vi.mocked(httpRequest).mockRejectedValue(new HttpError('down', 'network'));
    const outcome = await runLicenseProvision(baseDeps());
    expect(outcome).toEqual({ kind: 'skipped', reason: 'network or 5xx — no wipe' });
    expect(licenseWipeManaged).not.toHaveBeenCalled();
  });

  it('does not wipe on 401 during signOut (HC13c)', async () => {
    const gated = await runLicenseProvision(
      baseDeps({
        getSigningOut: () => true,
        getStep: () => 'email',
        getToken: () => null,
      }),
    );
    expect(gated.kind).toBe('skipped');
    expect(httpRequest).not.toHaveBeenCalled();

    let signingOut = false;
    let token: string | null = 'tok-1';
    let step: 'idle' | 'email' | 'otp' | 'authenticated' = 'authenticated';
    vi.mocked(httpRequest).mockImplementation(async () => {
      signingOut = true;
      token = null;
      step = 'email';
      throw new HttpError('Unauthorized', 'client', 401);
    });

    const midFlight = await runLicenseProvision(
      baseDeps({
        getToken: () => token,
        getSigningOut: () => signingOut,
        getStep: () => step,
      }),
    );
    expect(midFlight).toEqual({
      kind: 'skipped',
      reason: '401 during sign-out or token change',
    });
    expect(licenseWipeManaged).not.toHaveBeenCalled();
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it('does not wipe on 401 when getToken no longer matches the request token', async () => {
    let liveToken: string | null = 'tok-1';
    vi.mocked(httpRequest).mockImplementation(async () => {
      liveToken = 'tok-rotated';
      throw new HttpError('Unauthorized', 'client', 401);
    });

    const midFlight = await runLicenseProvision(
      baseDeps({
        getToken: () => liveToken,
        getSigningOut: () => false,
        getStep: () => 'authenticated',
      }),
    );
    expect(midFlight).toEqual({
      kind: 'skipped',
      reason: '401 during sign-out or token change',
    });
    expect(licenseWipeManaged).not.toHaveBeenCalled();
  });

  it('provisions active license after local verify (HC10/HC14 path)', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      status: 'active',
      licenseKey: JWT,
      tier: 'pro',
      expiresAt: null,
      perpetual: true,
      jti: 'test-jti',
    });

    const outcome = await runLicenseProvision(baseDeps());
    expect(licenseVerifyLocal).toHaveBeenCalledWith(JWT);
    expect(vaultSet).toHaveBeenCalledWith('studio/license-key', JWT, true);
    expect(licenseWriteManaged).toHaveBeenCalledWith(JWT);
    expect(daemonRestart).toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'provisioned', jti: 'test-jti' });
  });

  it('does not persist when verify fails (HC21)', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      status: 'active',
      licenseKey: JWT,
      tier: 'pro',
      expiresAt: null,
      perpetual: false,
      jti: 'bad',
    });
    vi.mocked(licenseVerifyLocal).mockResolvedValue({ valid: false, code: 'expired' });

    const outcome = await runLicenseProvision(baseDeps());
    expect(outcome).toEqual({ kind: 'verify-failed', code: 'expired' });
    expect(vaultSet).not.toHaveBeenCalled();
    expect(licenseWriteManaged).not.toHaveBeenCalled();
    expect(daemonRestart).not.toHaveBeenCalled();
  });

  it('wipes on revoked / none', async () => {
    vi.mocked(httpRequest).mockResolvedValue({
      status: 'revoked',
      licenseKey: null,
      tier: null,
      expiresAt: null,
      perpetual: false,
      jti: null,
    });

    const outcome = await runLicenseProvision(baseDeps());
    expect(licenseWipeManaged).toHaveBeenCalled();
    expect(vaultDelete).toHaveBeenCalledWith('studio/license-key');
    expect(daemonRestart).toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'wiped', status: 'revoked' });
  });

  it('skips file write when REVEALUI_LICENSE_KEY env override is set (HC11)', async () => {
    vi.mocked(licenseEnvOverride).mockResolvedValue(true);
    const outcome = await runLicenseProvision(baseDeps());
    expect(outcome).toEqual({ kind: 'env-override' });
    expect(httpRequest).not.toHaveBeenCalled();
    expect(licenseWriteManaged).not.toHaveBeenCalled();
  });
});
