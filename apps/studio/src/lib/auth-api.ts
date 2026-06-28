/**
 * Studio Auth API Client
 *
 * Communicates with the RevealUI API's /api/studio-auth endpoints
 * for device-based OTP authentication.
 */

import { HttpError, httpRequest } from './http';

// ── Response types ──────────────────────────────────────────────────────────

export interface LinkResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface VerifyResponse {
  success: boolean;
  token?: string;
  expiresAt?: string;
  user?: {
    id: string;
    email: string;
    name: string | null;
    role: string;
  };
  error?: string;
}

export interface RefreshResponse {
  success: boolean;
  token?: string;
  expiresAt?: string;
  error?: string;
}

export interface StatusResponse {
  authenticated: boolean;
  user?: {
    id: string;
    email: string;
    name: string | null;
    role: string;
  };
  device?: {
    id: string;
    name: string;
  };
  tokenExpiresAt?: string | null;
}

// ── Client ──────────────────────────────────────────────────────────────────

function getDeviceId(): string {
  const key = 'revealui-studio-device-id';
  let deviceId = localStorage.getItem(key);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(key, deviceId);
  }
  return deviceId;
}

function getDeviceName(): string {
  const platform = navigator.platform || 'Unknown';
  return `RevealUI Studio (${platform})`;
}

function endpoint(apiUrl: string, path: string): string {
  return `${apiUrl}/api/studio-auth${path}`;
}

function jsonInit(init: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  };
}

/**
 * Request helper for the `{ success, error }`-shaped endpoints. A categorized
 * {@link HttpError} (4xx/5xx/network/parse) is mapped back into the response's
 * own contract as `{ success: false, error }` with an actionable message — so
 * callers keep their existing `if (res.success)` branch but now see a useful
 * message instead of a generic "Unable to reach the API" for every failure.
 */
async function requestResult<T extends { success: boolean; error?: string }>(
  apiUrl: string,
  path: string,
  init: RequestInit,
): Promise<T> {
  try {
    return await httpRequest<T>(endpoint(apiUrl, path), jsonInit(init));
  } catch (err) {
    if (err instanceof HttpError) {
      return { success: false, error: err.message } as T;
    }
    throw err;
  }
}

/**
 * Request an OTP code to be sent to the given email.
 */
export async function linkDevice(apiUrl: string, email: string): Promise<LinkResponse> {
  return requestResult<LinkResponse>(apiUrl, '/link', {
    method: 'POST',
    body: JSON.stringify({
      email,
      deviceId: getDeviceId(),
      deviceName: getDeviceName(),
      deviceType: 'desktop',
    }),
  });
}

/**
 * Verify the OTP code and receive a bearer token.
 */
export async function verifyDevice(
  apiUrl: string,
  email: string,
  code: string,
): Promise<VerifyResponse> {
  return requestResult<VerifyResponse>(apiUrl, '/verify', {
    method: 'POST',
    body: JSON.stringify({
      email,
      deviceId: getDeviceId(),
      code,
    }),
  });
}

/**
 * Rotate the bearer token. Returns a new token.
 */
export async function refreshToken(apiUrl: string, token: string): Promise<RefreshResponse> {
  return requestResult<RefreshResponse>(apiUrl, '/refresh', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Revoke the bearer token (sign out). Best-effort: a failed revoke must never
 * block the local sign-out, so categorized HTTP failures are swallowed.
 */
export async function revokeToken(apiUrl: string, token: string): Promise<void> {
  try {
    await httpRequest(
      endpoint(apiUrl, '/revoke'),
      jsonInit({ method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }),
    );
  } catch (err) {
    if (err instanceof HttpError) return;
    throw err;
  }
}

/**
 * Check auth status and get user info.
 *
 * Intentionally throws {@link HttpError} on any failure: `use-auth` treats a
 * throw here as "API unreachable" and preserves the existing session (offline
 * access) rather than signing the user out on a transient server/network error.
 */
export async function checkStatus(apiUrl: string, token: string): Promise<StatusResponse> {
  return httpRequest<StatusResponse>(
    endpoint(apiUrl, '/status'),
    jsonInit({ method: 'GET', headers: { Authorization: `Bearer ${token}` } }),
  );
}
