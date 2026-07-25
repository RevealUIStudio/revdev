/**
 * B2 (GAP-421 guardrail-2 remediation): the GAP-353 adversarial suite,
 * replicated daemon-side. Ported from `@revealui/harnesses`
 * `server/__tests__/http-gateway.test.ts`, adapted from that package's
 * `DaemonStore` + injectable `dispatchHttp` stub to this package's raw
 * `PGlite` + real `dispatchRpc` (there is no pluggable dispatch here — every
 * authenticated call in this file uses `ping`, the one identity- and
 * license-exempt method, as the "a valid token grants real access" proof
 * instead of the harnesses original's stubbed `agent.spawn`/`agent.stop`).
 *
 * These cases must exist daemon-side BEFORE `@revealui/harnesses`
 * `server/http-gateway.ts` is retired — it is currently the only place any
 * of them are proven.
 */

import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findValidToken, getBootstrapSecretHash } from '../gateway-store.js';
import { migrate } from '../storage/migrate.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Mirrors the harnesses original: a hook that lets one test plant a file
// inside mkdirSync (the create-path EEXIST race), and a persistent-EEXIST
// simulator for the retry-cap test. Every other test leaves these null/false,
// so mkdirSync/writeFileSync pass straight through to the real implementation.
const fsHooks = vi.hoisted(() => ({
  beforeMkdir: null as (() => void) | null,
  forceCreateEexist: false,
  onCreateAttempt: null as (() => void) | null,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: ((path: Parameters<typeof actual.mkdirSync>[0], options) => {
      fsHooks.beforeMkdir?.();
      return actual.mkdirSync(path, options);
    }) as typeof actual.mkdirSync,
    writeFileSync: ((
      path: Parameters<typeof actual.writeFileSync>[0],
      data: Parameters<typeof actual.writeFileSync>[1],
      options?: Parameters<typeof actual.writeFileSync>[2],
    ) => {
      const flag = (options as { flag?: string } | undefined)?.flag;
      if (flag === 'wx') {
        fsHooks.onCreateAttempt?.();
        if (fsHooks.forceCreateEexist) {
          const err = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
          err.code = 'EEXIST';
          throw err;
        }
      }
      return actual.writeFileSync(path, data, options);
    }) as typeof actual.writeFileSync,
  };
});

// Imported after the mock so HttpGateway picks up the mocked node:fs.
const { HttpGateway } = await import('../http-gateway.js');
type HttpGatewayInstance = InstanceType<typeof HttpGateway>;
type AuthTuning = ConstructorParameters<typeof HttpGateway>[0]['authTuning'];

interface Harness {
  gateway: HttpGatewayInstance;
  db: PGlite;
  secretPath: string;
  base: string;
  dir: string;
}

const dirs: string[] = [];
const gateways: HttpGatewayInstance[] = [];
const dbs: PGlite[] = [];

async function boot(opts?: {
  authTuning?: AuthTuning;
  preSecret?: { contents: string; mode?: number };
  seedDb?: (db: PGlite) => Promise<void>;
  dir?: string;
}): Promise<Harness> {
  const dir = opts?.dir ?? mkdtempSync(join(tmpdir(), 'gw-authn-'));
  dirs.push(dir);
  const secretPath = join(dir, 'pairing-secret');
  if (opts?.preSecret) {
    writeFileSync(secretPath, opts.preSecret.contents, { mode: opts.preSecret.mode ?? 0o600 });
    chmodSync(secretPath, opts.preSecret.mode ?? 0o600);
  }

  const db = new PGlite();
  await migrate(db);
  dbs.push(db);
  if (opts?.seedDb) await opts.seedDb(db);

  const gateway = new HttpGateway({
    port: 0,
    host: '127.0.0.1',
    db,
    secretPath,
    authTuning: opts?.authTuning,
  });
  gateways.push(gateway);
  await gateway.initAuth();
  await gateway.start();

  return { gateway, db, secretPath, base: `http://127.0.0.1:${gateway.getPort()}`, dir };
}

/** Run the full challenge-response pairing flow and return the minted bearer token. */
async function pair(h: Harness, label?: string): Promise<string> {
  const nonceRes = await fetch(`${h.base}/api/pair`);
  expect(nonceRes.status).toBe(200);
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const secret = readFileSync(h.secretPath, 'utf8').trim();
  const hmac = createHmac('sha256', secret).update(nonce).digest('hex');
  const pairRes = await fetch(`${h.base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, hmac, label }),
  });
  expect(pairRes.status).toBe(200);
  const { token } = (await pairRes.json()) as { token: string };
  return token;
}

/** `ping` is the one identity- and license-exempt method — used as the "a valid token grants real access" proof. */
function rpc(base: string, token?: string): Promise<Response> {
  return fetch(`${base}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
  });
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.stop()));
  await Promise.all(dbs.splice(0).map((d) => d.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('HttpGateway fail-closed auth (GAP-353, daemon-side replication)', () => {
  describe('headline: a never-paired daemon refuses unauthenticated /rpc', () => {
    it('refuses an unauthenticated /rpc call without reaching dispatch', async () => {
      const h = await boot();
      const res = await rpc(h.base);
      expect(res.status).toBe(401);
    });

    it('refuses every unauthenticated /api/* route (nothing but pairing is pre-auth)', async () => {
      const h = await boot();
      const status = await fetch(`${h.base}/api/status`);
      expect(status.status).toBe(401);
      const stream = await fetch(`${h.base}/api/stream/some-process-id`);
      expect(stream.status).toBe(401);
    });
  });

  describe('challenge-response pairing', () => {
    it('mints a token on correct HMAC and authenticates /rpc with it', async () => {
      const h = await boot();
      const token = await pair(h, 'studio-macbook');

      const res = await rpc(h.base, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result?: unknown; error?: unknown };
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();
    });

    it('persists the token hash (never the plaintext) with expiry and label', async () => {
      const h = await boot();
      const token = await pair(h, 'studio-macbook');
      const row = await findValidToken(
        h.db,
        // sha256(token) is what must be stored, not the token itself
        createHash('sha256').update(token).digest('hex'),
      );
      expect(row).not.toBeNull();
      expect(row?.label).toBe('studio-macbook');
      expect(row?.expires_at).not.toBeNull();
      expect(await findValidToken(h.db, token)).toBeNull(); // plaintext is not a stored key
    });

    it('rejects a wrong HMAC with 403', async () => {
      const h = await boot();
      const { nonce } = (await (await fetch(`${h.base}/api/pair`)).json()) as { nonce: string };
      const res = await fetch(`${h.base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, hmac: 'deadbeef'.repeat(8) }),
      });
      expect(res.status).toBe(403);
    });

    it('does not accept a consumed nonce a second time', async () => {
      const h = await boot();
      const { nonce } = (await (await fetch(`${h.base}/api/pair`)).json()) as { nonce: string };
      const secret = readFileSync(h.secretPath, 'utf8').trim();
      const hmac = createHmac('sha256', secret).update(nonce).digest('hex');

      const first = await fetch(`${h.base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, hmac }),
      });
      expect(first.status).toBe(200);

      const replay = await fetch(`${h.base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, hmac }),
      });
      expect(replay.status).toBe(403);
    });

    it('consumes the nonce even on a failed attempt (no retry with a correct HMAC)', async () => {
      const h = await boot();
      const { nonce } = (await (await fetch(`${h.base}/api/pair`)).json()) as { nonce: string };
      const secret = readFileSync(h.secretPath, 'utf8').trim();

      const wrong = await fetch(`${h.base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, hmac: '00'.repeat(32) }),
      });
      expect(wrong.status).toBe(403);

      const correctHmac = createHmac('sha256', secret).update(nonce).digest('hex');
      const retry = await fetch(`${h.base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, hmac: correctHmac }),
      });
      expect(retry.status).toBe(403);
    });

    it('rejects an expired nonce', async () => {
      let clock = 1_000_000;
      const h = await boot({ authTuning: { now: () => clock, nonceTtlMs: 60_000 } });
      const { nonce } = (await (await fetch(`${h.base}/api/pair`)).json()) as { nonce: string };
      const secret = readFileSync(h.secretPath, 'utf8').trim();
      const hmac = createHmac('sha256', secret).update(nonce).digest('hex');

      clock += 60_001; // past the nonce TTL
      const res = await fetch(`${h.base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, hmac }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('rate limit + lockout (§D5)', () => {
    it('locks a source out after repeated failures and clears after the window', async () => {
      let clock = 5_000_000;
      const h = await boot({
        authTuning: {
          now: () => clock,
          lockoutThreshold: 3,
          baseLockoutMs: 30_000,
          globalFailureCeiling: 1000,
        },
      });
      const secret = readFileSync(h.secretPath, 'utf8').trim();

      for (let i = 0; i < 3; i++) {
        const { nonce } = (await (await fetch(`${h.base}/api/pair`)).json()) as { nonce: string };
        const res = await fetch(`${h.base}/api/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nonce, hmac: '11'.repeat(32) }),
        });
        expect(res.status).toBe(403);
      }

      const locked = (await (await fetch(`${h.base}/api/pair`)).json()) as { nonce: string };
      const goodHmac = createHmac('sha256', secret).update(locked.nonce).digest('hex');
      const lockedRes = await fetch(`${h.base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: locked.nonce, hmac: goodHmac }),
      });
      expect(lockedRes.status).toBe(429);

      clock += 30_001;
      const token = await pair(h);
      expect(token).toHaveLength(64);
    });
  });

  describe('restart durability (§D2)', () => {
    it('keeps a previously-issued token valid across a new gateway instance', async () => {
      const h = await boot();
      const token = await pair(h);
      await h.gateway.stop();

      // New gateway instance, SAME db + secret file (simulated daemon restart).
      const gateway2 = new HttpGateway({
        port: 0,
        host: '127.0.0.1',
        db: h.db,
        secretPath: h.secretPath,
      });
      gateways.push(gateway2);
      await gateway2.initAuth();
      await gateway2.start();
      const base2 = `http://127.0.0.1:${gateway2.getPort()}`;

      const authed = await rpc(base2, token);
      expect(authed.status).toBe(200);
      const unauth = await rpc(base2);
      expect(unauth.status).toBe(401);
    });
  });

  describe('boot honesty (§D7 / §7 R5)', () => {
    it('re-hashes an existing secret file into a fresh store (§7 R5)', async () => {
      const contents = 'a'.repeat(64);
      const h = await boot({ preSecret: { contents } });
      const stored = await getBootstrapSecretHash(h.db);
      const expected = createHash('sha256').update(contents).digest('hex');
      expect(stored).toBe(expected);
      const token = await pair(h);
      expect(token).toHaveLength(64);
    });

    it('refuses new pairings when the file is gone but a hash is on record; existing tokens still work', async () => {
      const knownToken = 'f'.repeat(64);
      const tokenHash = createHash('sha256').update(knownToken).digest('hex');
      const h = await boot({
        seedDb: async (db) => {
          const { putBootstrapSecretHash, insertToken } = await import('../gateway-store.js');
          await putBootstrapSecretHash(db, 'some-recorded-hash');
          await insertToken(db, { tokenHash });
        },
      });

      // No secret file was created (preSecret omitted) but a hash is on record → refuse pairing.
      const { nonce } = (await (await fetch(`${h.base}/api/pair`)).json()) as { nonce: string };
      const pairRes = await fetch(`${h.base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, hmac: '22'.repeat(32) }),
      });
      expect(pairRes.status).toBe(503);

      const authed = await rpc(h.base, knownToken);
      expect(authed.status).toBe(200);
    });

    it('refuses to use a group/other-readable secret file (§D7)', async () => {
      const h = await boot({ preSecret: { contents: 'b'.repeat(64), mode: 0o644 } });
      const { nonce } = (await (await fetch(`${h.base}/api/pair`)).json()) as { nonce: string };
      const secret = readFileSync(h.secretPath, 'utf8').trim();
      const hmac = createHmac('sha256', secret).update(nonce).digest('hex');
      const res = await fetch(`${h.base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, hmac }),
      });
      expect(res.status).toBe(503);
    });

    it('refuses a group-readable secret file via the fstat mode check (read-path TOCTOU)', async () => {
      const h = await boot({ preSecret: { contents: 'g'.repeat(64), mode: 0o640 } });
      const { nonce } = (await (await fetch(`${h.base}/api/pair`)).json()) as { nonce: string };
      const secret = readFileSync(h.secretPath, 'utf8').trim();
      const hmac = createHmac('sha256', secret).update(nonce).digest('hex');
      const res = await fetch(`${h.base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, hmac }),
      });
      expect(res.status).toBe(503);
    });

    it('refuses a secret file that is a symlink (read-path O_NOFOLLOW)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gw-authn-'));
      dirs.push(dir);
      const target = join(dir, 'attacker-secret');
      const attackerSecret = 'c'.repeat(64);
      writeFileSync(target, attackerSecret, { mode: 0o600 });
      const secretPath = join(dir, 'pairing-secret');
      symlinkSync(target, secretPath);

      const db = new PGlite();
      await migrate(db);
      dbs.push(db);
      const gateway = new HttpGateway({ port: 0, host: '127.0.0.1', db, secretPath });
      gateways.push(gateway);
      await gateway.initAuth();
      await gateway.start();
      const base = `http://127.0.0.1:${gateway.getPort()}`;

      expect(readFileSync(target, 'utf8')).toBe(attackerSecret);
      expect(await getBootstrapSecretHash(db)).toBeNull();
      const { nonce } = (await (await fetch(`${base}/api/pair`)).json()) as { nonce: string };
      const hmac = createHmac('sha256', attackerSecret).update(nonce).digest('hex');
      const res = await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, hmac }),
      });
      expect(res.status).toBe(503);
    });

    it('falls back to reading when another process wins the create race (EEXIST)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gw-authn-'));
      dirs.push(dir);
      const secretPath = join(dir, 'pairing-secret');
      const winner = 'e'.repeat(64);
      fsHooks.beforeMkdir = () => {
        if (!existsSync(secretPath)) writeFileSync(secretPath, winner, { mode: 0o600 });
      };

      try {
        const db = new PGlite();
        await migrate(db);
        dbs.push(db);
        const gateway = new HttpGateway({ port: 0, host: '127.0.0.1', db, secretPath });
        gateways.push(gateway);
        await gateway.initAuth();
        await gateway.start();
        const base = `http://127.0.0.1:${gateway.getPort()}`;

        expect(readFileSync(secretPath, 'utf8')).toBe(winner);
        expect(await getBootstrapSecretHash(db)).toBe(
          createHash('sha256').update(winner).digest('hex'),
        );
        const { nonce } = (await (await fetch(`${base}/api/pair`)).json()) as { nonce: string };
        const hmac = createHmac('sha256', winner).update(nonce).digest('hex');
        const res = await fetch(`${base}/api/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nonce, hmac }),
        });
        expect(res.status).toBe(200);
      } finally {
        fsHooks.beforeMkdir = null;
      }
    });

    it('bounds the create-path retry loop so a persistent EEXIST race cannot livelock startup (#1975 verdict fast-follow)', async () => {
      const SAFETY_VALVE = 200;
      const dir = mkdtempSync(join(tmpdir(), 'gw-authn-'));
      dirs.push(dir);
      const secretPath = join(dir, 'pairing-secret');
      let attempts = 0;
      fsHooks.forceCreateEexist = true;
      fsHooks.onCreateAttempt = () => {
        attempts++;
        if (attempts >= SAFETY_VALVE) fsHooks.forceCreateEexist = false;
      };

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const db = new PGlite();
        await migrate(db);
        dbs.push(db);
        const gateway = new HttpGateway({ port: 0, host: '127.0.0.1', db, secretPath });
        gateways.push(gateway);
        await gateway.initAuth();

        expect(attempts).toBeGreaterThan(0);
        expect(attempts).toBeLessThan(SAFETY_VALVE);

        await gateway.start();
        const base = `http://127.0.0.1:${gateway.getPort()}`;
        const { nonce } = (await (await fetch(`${base}/api/pair`)).json()) as { nonce: string };
        const res = await fetch(`${base}/api/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nonce, hmac: '00'.repeat(32) }),
        });
        expect(res.status).toBe(503);
      } finally {
        stderrSpy.mockRestore();
        fsHooks.forceCreateEexist = false;
        fsHooks.onCreateAttempt = null;
      }
    });
  });

  describe('pre-auth allowlist is an explicit constant (§7 R3)', () => {
    it('contains exactly the two pairing endpoints', async () => {
      const { PRE_AUTH_ROUTES } = await import('../http-gateway.js');
      expect(PRE_AUTH_ROUTES).toEqual([
        { method: 'GET', path: '/api/pair' },
        { method: 'POST', path: '/api/pair' },
      ]);
    });

    it('classifies routes correctly', async () => {
      const { isPreAuthRoute } = await import('../http-gateway.js');
      expect(isPreAuthRoute('GET', '/api/pair')).toBe(true);
      expect(isPreAuthRoute('POST', '/api/pair')).toBe(true);
      expect(isPreAuthRoute('POST', '/rpc')).toBe(false);
      expect(isPreAuthRoute('GET', '/api/status')).toBe(false);
      expect(isPreAuthRoute('GET', '/api/stream/some-process-id')).toBe(false);
    });
  });
});

describe('PairingRateLimiter', () => {
  it('applies exponential backoff past the threshold, capped at the ceiling', async () => {
    const { PairingRateLimiter } = await import('../http-gateway.js');
    const clock = 0;
    const rl = new PairingRateLimiter({
      now: () => clock,
      lockoutThreshold: 3,
      baseLockoutMs: 1000,
      maxLockoutMs: 4000,
      globalCeiling: 1000,
    });
    const src = '1.2.3.4';
    expect(rl.recordFailure(src).lockMs).toBe(0); // 1
    expect(rl.recordFailure(src).lockMs).toBe(0); // 2
    expect(rl.recordFailure(src).lockMs).toBe(1000); // 3  -  base
    expect(rl.recordFailure(src).lockMs).toBe(2000); // 4  -  base*2
    expect(rl.recordFailure(src).lockMs).toBe(4000); // 5  -  base*4
    expect(rl.recordFailure(src).lockMs).toBe(4000); // 6  -  capped at ceiling
  });

  it('reports a source as locked until the window elapses, and clears on success', async () => {
    const { PairingRateLimiter } = await import('../http-gateway.js');
    let clock = 0;
    const rl = new PairingRateLimiter({
      now: () => clock,
      lockoutThreshold: 1,
      baseLockoutMs: 5000,
      maxLockoutMs: 5000,
      globalCeiling: 1000,
    });
    const src = '9.9.9.9';
    rl.recordFailure(src);
    expect(rl.retryAfterMs(src)).toBe(5000);
    clock += 5000;
    expect(rl.retryAfterMs(src)).toBe(0);

    rl.recordFailure(src);
    rl.recordSuccess(src);
    expect(rl.retryAfterMs(src)).toBe(0);
  });

  it('trips a global cooldown at the global ceiling across sources', async () => {
    const { PairingRateLimiter } = await import('../http-gateway.js');
    const clock = 0;
    const rl = new PairingRateLimiter({
      now: () => clock,
      lockoutThreshold: 1000,
      baseLockoutMs: 2000,
      maxLockoutMs: 2000,
      globalCeiling: 3,
    });
    expect(rl.recordFailure('a').globalTripped).toBe(false);
    expect(rl.recordFailure('b').globalTripped).toBe(false);
    expect(rl.recordFailure('c').globalTripped).toBe(true);
    expect(rl.retryAfterMs('z')).toBe(2000);
  });
});
