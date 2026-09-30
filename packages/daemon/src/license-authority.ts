import { createHash } from 'node:crypto';

/** One hosted licensing owner for issuance, containment and dispatch checks. */
export const LICENSE_API_ORIGIN = 'https://api.revealui.com';

export interface AuthorityLicense {
  tier: 'pro' | 'max' | 'enterprise';
  customerId: string;
}

/** No positive cache or redirect: each invocation authenticates the exact current token. */
export async function verifyRegisteredLicense(
  licenseKey: string,
  expected: AuthorityLicense,
  transport: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await transport(`${LICENSE_API_ORIGIN}/api/license/verify`, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey, requireRegistration: true }),
    });
    if (!response.ok || response.redirected) return false;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') return false;
    const result = body as Record<string, unknown>;
    return (
      result.valid === true &&
      (result.reason === 'valid' || result.reason === 'support_expired') &&
      result.tier === expected.tier &&
      result.customerId === expected.customerId &&
      result.licenseKeyDigest === createHash('sha256').update(licenseKey).digest('hex')
    );
  } catch {
    return false;
  }
}
