import { createHash, createPublicKey } from 'node:crypto';

/** One hosted licensing owner for issuance, containment and dispatch checks. */
export const LICENSE_API_ORIGIN = 'https://api.revealui.com';
const LICENSE_ISSUER = 'https://revealui.com';
const LICENSE_AUDIENCE = 'revealui-license';
const TRUST_RESPONSE_MAX_BYTES = 16 * 1024;
const TRUST_KEY_MAX_BYTES = 2 * 1024;
const TRUST_FETCH_TIMEOUT_MS = 5_000;

export type LicenseTrustKey = Readonly<{
  role: 'current' | 'next';
  algorithm: 'EdDSA';
  publicKey: string;
  jwtKid: string;
  keyId: string;
}>;

export type LicenseTrustSnapshot = Readonly<{
  version: 1;
  issuer: typeof LICENSE_ISSUER;
  audience: typeof LICENSE_AUDIENCE;
  keys: readonly LicenseTrustKey[];
  digest: string;
  generation: number;
}>;

let trustRequestGeneration = 0;
let acceptedTrustGeneration = 0;
let acceptedTrustSnapshot: LicenseTrustSnapshot | null = null;

function rejectLatestTrustRequest(requestGeneration: number): null {
  if (requestGeneration === trustRequestGeneration) {
    acceptedTrustGeneration += 1;
    acceptedTrustSnapshot = null;
  }
  return null;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function describeTrustKey(value: unknown, expectedRole: 'current' | 'next'): LicenseTrustKey {
  const key = record(value);
  if (
    !key ||
    !exactKeys(key, ['role', 'algorithm', 'publicKey', 'jwtKid', 'keyId']) ||
    key.role !== expectedRole ||
    key.algorithm !== 'EdDSA' ||
    typeof key.publicKey !== 'string' ||
    typeof key.jwtKid !== 'string' ||
    !/^[0-9a-f]{8}$/.test(key.jwtKid) ||
    typeof key.keyId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(key.keyId)
  ) {
    throw new Error('Invalid license trust entry');
  }

  const publicKey = key.publicKey.trim();
  if (
    Buffer.byteLength(publicKey, 'utf8') > TRUST_KEY_MAX_BYTES ||
    !/^-----BEGIN PUBLIC KEY-----\r?\n/.test(publicKey) ||
    !/\r?\n-----END PUBLIC KEY-----$/.test(publicKey)
  ) {
    throw new Error('Invalid license trust public key');
  }
  const body = publicKey
    .slice('-----BEGIN PUBLIC KEY-----'.length, -'-----END PUBLIC KEY-----'.length)
    .replaceAll('\r', '')
    .replaceAll('\n', '');
  if (!body || body.includes('-')) throw new Error('Invalid license trust public key');
  const der = Buffer.from(body, 'base64');
  if (der.toString('base64') !== body) throw new Error('Noncanonical license trust public key');
  const parsed = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (parsed.asymmetricKeyType !== 'ed25519') throw new Error('License trust key must be Ed25519');
  const canonicalDer = parsed.export({ format: 'der', type: 'spki' });
  if (!canonicalDer.equals(der)) throw new Error('Noncanonical license trust SPKI');
  if (sha256(canonicalDer) !== key.keyId) throw new Error('License trust key ID mismatch');
  if (sha256(publicKey).slice(0, 8) !== key.jwtKid)
    throw new Error('License trust JWT hint mismatch');

  return Object.freeze({
    role: expectedRole,
    algorithm: 'EdDSA',
    publicKey,
    jwtKid: key.jwtKid,
    keyId: key.keyId,
  });
}

function parseLicenseTrustManifest(input: unknown): Omit<LicenseTrustSnapshot, 'generation'> {
  const manifest = record(input);
  if (
    !manifest ||
    !exactKeys(manifest, ['version', 'issuer', 'audience', 'keys', 'digest'], ['publicKey']) ||
    manifest.version !== 1 ||
    manifest.issuer !== LICENSE_ISSUER ||
    manifest.audience !== LICENSE_AUDIENCE ||
    typeof manifest.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(manifest.digest) ||
    !Array.isArray(manifest.keys) ||
    manifest.keys.length < 1 ||
    manifest.keys.length > 2
  ) {
    throw new Error('Invalid license trust manifest');
  }

  const keys = manifest.keys.map((key, index) =>
    describeTrustKey(key, index === 0 ? 'current' : 'next'),
  );
  const keyIds = new Set(keys.map(({ keyId }) => keyId));
  const jwtKids = new Set(keys.map(({ jwtKid }) => jwtKid));
  if (keyIds.size !== keys.length || jwtKids.size !== keys.length) {
    throw new Error('Duplicate license trust identity');
  }
  if (manifest.publicKey !== undefined && manifest.publicKey !== keys[0]?.publicKey) {
    throw new Error('Legacy license public key does not match current trust key');
  }
  const digestInput = JSON.stringify({
    version: 1,
    issuer: LICENSE_ISSUER,
    audience: LICENSE_AUDIENCE,
    keys: keys.map(({ role, algorithm, keyId }) => ({ role, algorithm, keyId })),
  });
  if (sha256(digestInput) !== manifest.digest) throw new Error('License trust digest mismatch');

  return Object.freeze({
    version: 1,
    issuer: LICENSE_ISSUER,
    audience: LICENSE_AUDIENCE,
    keys: Object.freeze(keys),
    digest: manifest.digest,
  });
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > TRUST_RESPONSE_MAX_BYTES
    ) {
      void response.body?.cancel().catch(() => {});
      throw new Error('License trust response exceeds supported size');
    }
  }
  if (!response.body) throw new Error('License trust response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let fullyRead = false;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('License trust request timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) {
        fullyRead = true;
        break;
      }
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > TRUST_RESPONSE_MAX_BYTES)
        throw new Error('License trust response exceeds supported size');
      chunks.push(value);
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (!fullyRead) void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Cancellation can leave a read pending until the source settles;
      // cleanup must not extend the network deadline.
    }
  }
  signal.throwIfAborted();
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

/**
 * Fetch and validate the fixed hosted trust set. Every call is fresh. A
 * response from an older overlapping request cannot replace a newer one.
 */
export async function fetchLicenseTrustSet(
  transport: typeof fetch = fetch,
): Promise<LicenseTrustSnapshot | null> {
  const requestGeneration = ++trustRequestGeneration;
  const signal = AbortSignal.timeout(TRUST_FETCH_TIMEOUT_MS);
  try {
    const response = await transport(`${LICENSE_API_ORIGIN}/api/license/public-key`, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: { Accept: 'application/json' },
    });
    if (
      response.status !== 200 ||
      response.redirected ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    ) {
      return rejectLatestTrustRequest(requestGeneration);
    }
    const body = await readBoundedBody(response, signal);
    const manifest = parseLicenseTrustManifest(JSON.parse(body) as unknown);
    if (requestGeneration !== trustRequestGeneration) return null;
    if (acceptedTrustSnapshot?.digest !== manifest.digest) acceptedTrustGeneration += 1;
    acceptedTrustSnapshot = Object.freeze({ ...manifest, generation: acceptedTrustGeneration });
    return acceptedTrustSnapshot;
  } catch {
    return rejectLatestTrustRequest(requestGeneration);
  }
}

export function getAcceptedLicenseTrustSet(): LicenseTrustSnapshot | null {
  return acceptedTrustSnapshot;
}

/** Start a daemon lifecycle without inheriting trust from an earlier process start. */
export function beginLicenseTrustLifecycle(): void {
  trustRequestGeneration += 1;
  acceptedTrustGeneration += 1;
  acceptedTrustSnapshot = null;
}

export function isCurrentLicenseTrustSet(snapshot: LicenseTrustSnapshot): boolean {
  return (
    acceptedTrustSnapshot?.digest === snapshot.digest &&
    snapshot.generation === acceptedTrustGeneration
  );
}

export interface AuthorityLicense {
  tier: 'pro' | 'max' | 'enterprise';
  customerId: string;
  verifiedKeyId: string;
}

/** No positive cache or redirect: each invocation authenticates the exact current token. */
export async function verifyRegisteredLicense(
  licenseKey: string,
  expected: AuthorityLicense,
  trustSet: LicenseTrustSnapshot | null = getAcceptedLicenseTrustSet(),
  transport: typeof fetch = fetch,
): Promise<boolean> {
  if (!trustSet || !isCurrentLicenseTrustSet(trustSet)) return false;
  const signal = AbortSignal.timeout(TRUST_FETCH_TIMEOUT_MS);
  try {
    const response = await transport(`${LICENSE_API_ORIGIN}/api/license/verify`, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal,
      headers: { 'Content-Type': 'application/json' },
      // codeql[js/file-access-to-http] intended licenseKey POST to fixed LICENSE_API_ORIGIN.
      body: JSON.stringify({ licenseKey, requireRegistration: true }),
    });
    if (
      response.status !== 200 ||
      response.redirected ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    ) {
      return false;
    }
    const body: unknown = JSON.parse(await readBoundedBody(response, signal));
    if (!body || typeof body !== 'object') return false;
    const result = body as Record<string, unknown>;
    return (
      isCurrentLicenseTrustSet(trustSet) &&
      result.valid === true &&
      (result.reason === 'valid' || result.reason === 'support_expired') &&
      result.tier === expected.tier &&
      result.customerId === expected.customerId &&
      result.licenseKeyDigest === createHash('sha256').update(licenseKey).digest('hex') &&
      result.trustSetDigest === trustSet.digest &&
      result.verifiedKeyId === expected.verifiedKeyId &&
      trustSet.keys.some((key) => key.keyId === expected.verifiedKeyId)
    );
  } catch {
    return false;
  }
}
