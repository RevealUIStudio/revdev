/**
 * Studio license auto-provision — fetch /current, verify, write or wipe KEY_FILE.
 *
 * Runs only when authenticated, not localMode, licenseAutoProvision on, and
 * not signingOut. Does not implement the 6h timer (PR-4).
 */

import { checkStatus, refreshToken } from './auth-api';
import { HttpError, httpRequest } from './http';
import {
  daemonRestart,
  licenseEnvOverride,
  licenseVerifyLocal,
  licenseWipeManaged,
  licenseWriteManaged,
  vaultDelete,
  vaultSet,
} from './invoke';

export const VAULT_LICENSE_PATH = 'studio/license-key';

export type LicenseCurrentStatus = 'active' | 'none' | 'revoked' | 'support_expired';

export interface LicenseCurrentResponse {
  status: LicenseCurrentStatus;
  licenseKey: string | null;
  tier: 'pro' | 'max' | 'enterprise' | null;
  expiresAt: string | null;
  perpetual: boolean;
  jti: string | null;
}

export type LicenseProvisionOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'env-override' }
  | { kind: 'flag-off' }
  | { kind: 'unchanged' }
  | { kind: 'provisioned'; jti: string | null }
  | { kind: 'wiped'; status: 'none' | 'revoked' }
  | { kind: 'verify-failed'; code?: string }
  | { kind: 'error'; message: string };

export interface LicenseProvisionDeps {
  apiUrl: string;
  getToken: () => string | null;
  getSigningOut: () => boolean;
  getStep: () => 'idle' | 'email' | 'otp' | 'authenticated';
  localMode: boolean;
  licenseAutoProvision: boolean;
  /** Optional AbortSignal for tests / unmount. */
  signal?: AbortSignal;
}

export function licenseProvisionMessage(outcome: LicenseProvisionOutcome): string | null {
  switch (outcome.kind) {
    case 'env-override':
      return 'Using REVEALUI_LICENSE_KEY from the environment.';
    case 'verify-failed':
      return 'License could not be verified. Use /account/license.';
    case 'wiped':
      return outcome.status === 'revoked'
        ? 'License revoked. Rotate or contact support.'
        : 'No active license. Use /account/license.';
    case 'error':
      return outcome.message;
    default:
      return null;
  }
}

export async function fetchLicenseCurrent(
  apiUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<LicenseCurrentResponse> {
  return httpRequest<LicenseCurrentResponse>(`${apiUrl}/api/license/current`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal,
  });
}

async function writeMachine(jwt: string): Promise<{ changed: boolean }> {
  await vaultSet(VAULT_LICENSE_PATH, jwt, true);
  const result = await licenseWriteManaged(jwt);
  return { changed: result.changed };
}

async function wipeMachine(): Promise<boolean> {
  const result = await licenseWipeManaged();
  if (!result.wiped) {
    return false;
  }
  try {
    await vaultDelete(VAULT_LICENSE_PATH);
  } catch {
    // Vault may be unavailable in browser mocks; file wipe already gated wipe.
  }
  return true;
}

async function handleUnauthorized(
  deps: LicenseProvisionDeps,
  token: string,
): Promise<LicenseProvisionOutcome> {
  if (
    deps.getSigningOut() ||
    deps.getStep() !== 'authenticated' ||
    deps.getToken() === null ||
    deps.getToken() !== token
  ) {
    return { kind: 'skipped', reason: '401 during sign-out or token change' };
  }

  const refreshed = await refreshToken(deps.apiUrl, token);
  if (refreshed.success && refreshed.token) {
    try {
      const retry = await fetchLicenseCurrent(deps.apiUrl, refreshed.token, deps.signal);
      return await applyCurrent(retry);
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        // fall through to status check
      } else if (err instanceof HttpError && err.status === 404) {
        return { kind: 'flag-off' };
      } else if (
        err instanceof HttpError &&
        (err.kind === 'network' ||
          err.kind === 'server' ||
          (err.status !== undefined && err.status >= 500))
      ) {
        return { kind: 'skipped', reason: 'network or 5xx — no wipe' };
      } else {
        return {
          kind: 'error',
          message: err instanceof Error ? err.message : 'License fetch failed after refresh',
        };
      }
    }
  }

  if (deps.getSigningOut() || deps.getStep() !== 'authenticated' || deps.getToken() === null) {
    return { kind: 'skipped', reason: '401 during sign-out or token change' };
  }

  try {
    const status = await checkStatus(deps.apiUrl, deps.getToken() ?? token);
    if (status.authenticated === false) {
      const wiped = await wipeMachine();
      if (wiped) {
        try {
          await daemonRestart();
        } catch {
          // best-effort
        }
        return { kind: 'wiped', status: 'revoked' };
      }
      return { kind: 'skipped', reason: '401 remote-dead but no managed marker' };
    }
    return { kind: 'skipped', reason: '401 but status still authenticated' };
  } catch {
    return { kind: 'skipped', reason: '401 and status unreachable' };
  }
}

async function applyCurrent(current: LicenseCurrentResponse): Promise<LicenseProvisionOutcome> {
  if (current.status === 'active' || current.status === 'support_expired') {
    const jwt = current.licenseKey?.trim() ?? '';
    if (!jwt) {
      return { kind: 'error', message: 'License response missing licenseKey.' };
    }

    const verified = await licenseVerifyLocal(jwt);
    if (!verified.valid) {
      return { kind: 'verify-failed', code: verified.code };
    }

    const { changed } = await writeMachine(jwt);
    if (changed) {
      try {
        await daemonRestart();
      } catch {
        // File is on disk; restart can be retried by the operator.
      }
      return { kind: 'provisioned', jti: current.jti };
    }
    return { kind: 'unchanged' };
  }

  if (current.status === 'none' || current.status === 'revoked') {
    const wiped = await wipeMachine();
    if (wiped) {
      try {
        await daemonRestart();
      } catch {
        // best-effort
      }
    }
    return { kind: 'wiped', status: current.status };
  }

  return { kind: 'skipped', reason: `unhandled status ${(current as { status: string }).status}` };
}

/**
 * Run one auto-provision pass. Safe to call repeatedly; skips when gated off.
 */
export async function runLicenseProvision(
  deps: LicenseProvisionDeps,
): Promise<LicenseProvisionOutcome> {
  if (deps.localMode) {
    return { kind: 'skipped', reason: 'localMode' };
  }
  if (!deps.licenseAutoProvision) {
    return { kind: 'skipped', reason: 'licenseAutoProvision=false' };
  }
  if (deps.getSigningOut() || deps.getStep() !== 'authenticated') {
    return { kind: 'skipped', reason: 'not authenticated or signingOut' };
  }

  try {
    if (await licenseEnvOverride()) {
      return { kind: 'env-override' };
    }
  } catch {
    // Browser mock / invoke failure — continue to fetch path.
  }

  const token = deps.getToken();
  if (!token) {
    return { kind: 'skipped', reason: 'no token' };
  }

  try {
    const current = await fetchLicenseCurrent(deps.apiUrl, token, deps.signal);
    return await applyCurrent(current);
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 404) {
        return { kind: 'flag-off' };
      }
      if (err.status === 401) {
        return handleUnauthorized(deps, token);
      }
      if (
        err.kind === 'network' ||
        err.kind === 'server' ||
        (err.status !== undefined && err.status >= 500)
      ) {
        return { kind: 'skipped', reason: 'network or 5xx — no wipe' };
      }
    }
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : 'License provision failed',
    };
  }
}
