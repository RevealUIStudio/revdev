import { createHash, createPublicKey } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { guardRpcMethod } from '../guard.js';
import {
  fetchLicenseTrustSet,
  getAcceptedLicenseTrustSet,
  isCurrentLicenseTrustSet,
  LICENSE_API_ORIGIN,
  verifyRegisteredLicense,
} from '../license-authority.js';
import { revokeJti } from '../license-crypto.js';
import {
  generateTestLicense,
  installTestLicenseAuthority,
  setTestLicenseEnv,
} from './test-license-helper.js';

afterEach(() => vi.unstubAllGlobals());

function trustManifest(publicKeys: string[]) {
  const keys = publicKeys.map((publicKey, index) => {
    const normalizedKey = publicKey.trim();
    const der = createPublicKey(normalizedKey).export({ format: 'der', type: 'spki' });
    return {
      role: index === 0 ? 'current' : 'next',
      algorithm: 'EdDSA',
      publicKey: normalizedKey,
      jwtKid: createHash('sha256').update(normalizedKey).digest('hex').slice(0, 8),
      keyId: createHash('sha256').update(der).digest('hex'),
    };
  });
  const digestInput = JSON.stringify({
    version: 1,
    issuer: 'https://revealui.com',
    audience: 'revealui-license',
    keys: keys.map(({ role, algorithm, keyId }) => ({ role, algorithm, keyId })),
  });
  return {
    version: 1,
    issuer: 'https://revealui.com',
    audience: 'revealui-license',
    keys,
    digest: createHash('sha256').update(digestInput).digest('hex'),
    publicKey: keys[0]?.publicKey,
  };
}

function jsonResponse(body: unknown): Response {
  return Response.json(body);
}

it('loads the fixed bounded trust manifest as an immutable current snapshot', async () => {
  const kit = generateTestLicense('pro');
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(jsonResponse(trustManifest([kit.publicKey])));
  const snapshot = await fetchLicenseTrustSet(transport);
  expect(snapshot).toMatchObject({
    version: 1,
    issuer: 'https://revealui.com',
    audience: 'revealui-license',
    keys: [{ role: 'current', algorithm: 'EdDSA', publicKey: kit.publicKey.trim() }],
  });
  expect(snapshot).toBe(getAcceptedLicenseTrustSet());
  expect(snapshot && isCurrentLicenseTrustSet(snapshot)).toBe(true);
  expect(transport).toHaveBeenCalledWith(
    'https://api.revealui.com/api/license/public-key',
    expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json' },
    }),
  );
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot?.keys)).toBe(true);
  expect(Object.isFrozen(snapshot?.keys[0])).toBe(true);
});

it('preserves a hosted CRLF PEM representation while validating its SPKI identity', async () => {
  const kit = generateTestLicense('pro');
  const crlfKey = kit.publicKey.replaceAll('\n', '\r\n');
  const snapshot = await fetchLicenseTrustSet(
    vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(trustManifest([crlfKey]))),
  );
  expect(snapshot?.keys[0]?.publicKey).toBe(crlfKey.trim());
  expect(snapshot?.keys[0]?.jwtKid).toBe(
    createHash('sha256').update(crlfKey.trim()).digest('hex').slice(0, 8),
  );
});

it.each([
  [
    'wrong content type',
    (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'text/plain' } }),
  ],
  [
    'unknown manifest field',
    (body: unknown) =>
      Response.json({ ...(body as object), alternateOrigin: 'https://evil.invalid' }),
  ],
  ['wrong audience', (body: unknown) => Response.json({ ...(body as object), audience: 'other' })],
  [
    'wrong digest',
    (body: unknown) => Response.json({ ...(body as object), digest: '0'.repeat(64) }),
  ],
  [
    'wrong JWT hint',
    (body: unknown) => {
      const manifest = body as ReturnType<typeof trustManifest>;
      return Response.json({
        ...manifest,
        keys: manifest.keys.map((key, index) => (index ? key : { ...key, jwtKid: '00000000' })),
      });
    },
  ],
  [
    'malformed NEXT entry',
    (body: unknown) => {
      const manifest = body as ReturnType<typeof trustManifest>;
      return Response.json({
        ...manifest,
        keys: [...manifest.keys, { ...manifest.keys[0], role: 'next', publicKey: 'invalid' }],
      });
    },
  ],
])('rejects %s without installing a trust snapshot', async (_name, makeResponse) => {
  const kit = generateTestLicense('pro');
  const response = makeResponse(trustManifest([kit.publicKey]));
  expect(await fetchLicenseTrustSet(vi.fn<typeof fetch>().mockResolvedValue(response))).toBeNull();
});

it('enforces the decoded response bound and fatal UTF-8 decoding', async () => {
  const oversized = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 + 1));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
  const invalidUtf8 = new Response(Uint8Array.from([0xff]), {
    headers: { 'content-type': 'application/json' },
  });
  for (const response of [oversized, invalidUtf8]) {
    expect(
      await fetchLicenseTrustSet(vi.fn<typeof fetch>().mockResolvedValue(response)),
    ).toBeNull();
  }
});

it('cancels a streamed trust response when it exceeds the body bound', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );

  expect(await fetchLicenseTrustSet(vi.fn<typeof fetch>().mockResolvedValue(response))).toBeNull();
  expect(cancelled).toBe(true);
});

it('rejects a trust response whose body stalls past the request deadline', async () => {
  const timedOutSignal = AbortSignal.timeout(1);
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timedOutSignal);
  try {
    const response = new Response(
      new ReadableStream({ cancel: () => new Promise<void>(() => {}) }),
      { headers: { 'content-type': 'application/json' } },
    );
    const startedAt = Date.now();
    expect(
      await fetchLicenseTrustSet(vi.fn<typeof fetch>().mockResolvedValue(response)),
    ).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(100);
  } finally {
    timeout.mockRestore();
  }
});

it('prevents an older overlapping trust fetch from replacing a newer key set', async () => {
  const olderKit = generateTestLicense('pro');
  const newerKit = generateTestLicense('max');
  let resolveOlder!: (response: Response) => void;
  let resolveNewer!: (response: Response) => void;
  const olderTransport = vi.fn<typeof fetch>(
    () => new Promise((resolve) => (resolveOlder = resolve)),
  );
  const newerTransport = vi.fn<typeof fetch>(
    () => new Promise((resolve) => (resolveNewer = resolve)),
  );
  const olderPromise = fetchLicenseTrustSet(olderTransport);
  const newerPromise = fetchLicenseTrustSet(newerTransport);
  resolveNewer(jsonResponse(trustManifest([newerKit.publicKey])));
  const newerSnapshot = await newerPromise;
  resolveOlder(jsonResponse(trustManifest([olderKit.publicKey])));
  expect(await olderPromise).toBeNull();
  expect(newerSnapshot?.keys[0]?.publicKey).toBe(newerKit.publicKey.trim());
  expect(newerSnapshot).toBe(getAcceptedLicenseTrustSet());
  expect(newerSnapshot && isCurrentLicenseTrustSet(newerSnapshot)).toBe(true);
});

it('invalidates a previously accepted snapshot after the latest trust fetch fails', async () => {
  const kit = generateTestLicense('pro');
  const accepted = await fetchSnapshot(kit.publicKey);
  expect(accepted).not.toBeNull();
  await fetchLicenseTrustSet(vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')));
  expect(getAcceptedLicenseTrustSet()).toBeNull();
  expect(accepted && isCurrentLicenseTrustSet(accepted)).toBe(false);
});

async function fetchSnapshot(publicKey: string) {
  return fetchLicenseTrustSet(
    vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(trustManifest([publicKey]))),
  );
}

function evidence(
  key: string,
  snapshot: NonNullable<Awaited<ReturnType<typeof fetchLicenseTrustSet>>>,
) {
  return {
    valid: true,
    reason: 'valid',
    tier: 'pro',
    customerId: 'synthetic-customer',
    licenseKeyDigest: createHash('sha256').update(key).digest('hex'),
    trustSetDigest: snapshot.digest,
    verifiedKeyId: snapshot.keys[0]?.keyId,
  };
}

it('checks the fixed authority every time with no redirects or positive response cache', async () => {
  const kit = generateTestLicense('pro');
  const snapshot = await fetchSnapshot(kit.publicKey);
  expect(snapshot).not.toBeNull();
  if (!snapshot) return;
  const expected = {
    tier: 'pro' as const,
    customerId: 'synthetic-customer',
    verifiedKeyId: snapshot.keys[0]?.keyId ?? '',
  };
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(evidence(kit.licenseKey, snapshot)))
    .mockResolvedValueOnce(
      Response.json({ ...evidence(kit.licenseKey, snapshot), trustSetDigest: 'f'.repeat(64) }),
    )
    .mockResolvedValueOnce(
      Response.json({ ...evidence(kit.licenseKey, snapshot), verifiedKeyId: 'f'.repeat(64) }),
    )
    .mockResolvedValueOnce(Response.json({ valid: false, reason: 'revoked' }));
  expect(await verifyRegisteredLicense(kit.licenseKey, expected, snapshot, transport)).toBe(true);
  expect(await verifyRegisteredLicense(kit.licenseKey, expected, snapshot, transport)).toBe(false);
  expect(await verifyRegisteredLicense(kit.licenseKey, expected, snapshot, transport)).toBe(false);
  expect(await verifyRegisteredLicense(kit.licenseKey, expected, snapshot, transport)).toBe(false);
  expect(transport).toHaveBeenCalledTimes(4);
  expect(transport).toHaveBeenCalledWith(
    'https://api.revealui.com/api/license/verify',
    expect.objectContaining({
      redirect: 'error',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    }),
  );
});

it.each([
  { valid: false },
  { licenseKeyDigest: 'different-token' },
  { customerId: 'other-customer' },
  { tier: 'enterprise' },
  { reason: 'migration_required' },
])('denies mismatched authority evidence %j', async (mismatch) => {
  const kit = generateTestLicense('pro');
  const snapshot = await fetchSnapshot(kit.publicKey);
  expect(snapshot).not.toBeNull();
  if (!snapshot) return;
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ...evidence(kit.licenseKey, snapshot), ...mismatch }));
  expect(
    await verifyRegisteredLicense(
      kit.licenseKey,
      {
        tier: 'pro',
        customerId: 'synthetic-customer',
        verifiedKeyId: snapshot.keys[0]?.keyId ?? '',
      },
      snapshot,
      transport,
    ),
  ).toBe(false);
});

it('denies malformed responses, transport failure, and non-success status', async () => {
  const expected = { tier: 'pro' as const, customerId: 'synthetic-customer' };
  for (const transport of [
    vi.fn<typeof fetch>().mockResolvedValue(new Response('not-json')),
    vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 503 })),
    vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic TLS failure')),
  ]) {
    const kit = generateTestLicense('pro');
    const snapshot = await fetchSnapshot(kit.publicKey);
    expect(snapshot).not.toBeNull();
    expect(
      await verifyRegisteredLicense(
        'synthetic-token',
        { ...expected, verifiedKeyId: snapshot?.keys[0]?.keyId ?? '' },
        snapshot,
        transport,
      ),
    ).toBe(false);
  }
});

it('denies configuration replacement while a paid request is awaiting authority', async () => {
  const original = generateTestLicense('pro');
  const replacement = generateTestLicense('pro');
  setTestLicenseEnv(original);
  const originalSnapshot = await fetchSnapshot(original.publicKey);
  if (!originalSnapshot) throw new Error('synthetic trust snapshot failed to load');
  let postAwaited = false;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).endsWith('/public-key')) {
      return jsonResponse(trustManifest([original.publicKey]));
    }
    postAwaited = true;
    setTestLicenseEnv(replacement);
    return Response.json(evidence(original.licenseKey, originalSnapshot));
  });
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(false);
  expect(postAwaited).toBe(true);
});

it('denies when the accepted trust generation changes during registration', async () => {
  const kit = generateTestLicense('pro');
  const other = generateTestLicense('pro');
  setTestLicenseEnv(kit);
  const originalSnapshot = await fetchSnapshot(kit.publicKey);
  if (!originalSnapshot) throw new Error('synthetic trust snapshot failed to load');
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).endsWith('/public-key')) {
      return jsonResponse(trustManifest([kit.publicKey]));
    }
    await fetchLicenseTrustSet(
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(trustManifest([other.publicKey]))),
    );
    return Response.json(evidence(kit.licenseKey, originalSnapshot));
  });
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(false);
});

it('denies when local revocation changes during registration', async () => {
  const kit = generateTestLicense('pro', true, { jti: 'revoked-during-registration' });
  setTestLicenseEnv(kit);
  const snapshot = await fetchSnapshot(kit.publicKey);
  if (!snapshot) throw new Error('synthetic trust snapshot failed to load');
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).endsWith('/public-key')) return jsonResponse(trustManifest([kit.publicKey]));
    revokeJti('revoked-during-registration');
    return Response.json(evidence(kit.licenseKey, snapshot));
  });
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(false);
});

it('denies when a credential expires during registration', async () => {
  const kit = generateTestLicense('pro', false, { daysUntilExpiry: 1 / 86_400 });
  setTestLicenseEnv(kit);
  const snapshot = await fetchSnapshot(kit.publicKey);
  if (!snapshot) throw new Error('synthetic trust snapshot failed to load');
  const now = Date.now();
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => now + 5_000);
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).endsWith('/public-key')) return jsonResponse(trustManifest([kit.publicKey]));
    return Response.json(evidence(kit.licenseKey, snapshot));
  });
  try {
    expect((await guardRpcMethod('agent.spawn')).allowed).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

it('requires registered identity and avoids authority calls for exempt/free dispatch', async () => {
  setTestLicenseEnv(generateTestLicense('pro', true, { jti: null }));
  const transport = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', transport);
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(false);
  expect((await guardRpcMethod('ping')).allowed).toBe(true);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0]?.[0]).toBe(`${LICENSE_API_ORIGIN}/api/license/public-key`);
});

it('the synthetic authority denies a signed complete identity without exact registration', async () => {
  installTestLicenseAuthority();
  setTestLicenseEnv(generateTestLicense('pro', true, { registered: false }));
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(false);
});

it('restores and reinstalls exact registration without masking an explicit outage', async () => {
  const nativeFetch = globalThis.fetch;
  const kit = generateTestLicense('pro');
  setTestLicenseEnv(kit);
  installTestLicenseAuthority();
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(true);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic outage')));
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(false);
  vi.unstubAllGlobals();
  expect(globalThis.fetch).toBe(nativeFetch);
  installTestLicenseAuthority();
  expect((await guardRpcMethod('agent.spawn')).allowed).toBe(true);
});
