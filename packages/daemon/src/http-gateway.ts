import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import {
  findValidToken,
  getBootstrapSecretHash,
  insertToken,
  pruneExpiredTokens,
  putBootstrapSecretHash,
} from './gateway-store.js';
import { dispatchRpc, type RpcRequest, type RpcResponse, type SocketContext } from './server.js';
import {
  type AgentExitEvent,
  type AgentOutputEvent,
  agentEvents,
  redeemStreamTicket,
} from './spawn-events.js';

/**
 * HTTP gateway that exposes the RevDev daemon over TCP (GAP-421
 * daemon-ownership ADR — ported from `@revealui/harnesses`
 * `server/http-gateway.ts`, preserving the on-the-wire contract byte for
 * byte so the Studio pairing client (`apps/studio/src/lib/invoke.ts`
 * `pairWithDaemon`) needs no protocol change).
 *
 * Routes:
 *   POST /rpc                        -  JSON-RPC 2.0 proxy, through the SAME
 *                                        dispatchRpc the Unix socket uses (license
 *                                        guard, param validation, signature gate,
 *                                        identity gate, permission gate — one
 *                                        authorization path, never a parallel one)
 *   GET  /api/pair                   -  Issue a single-use pairing nonce (pre-auth)
 *   POST /api/pair                   -  Submit an HMAC challenge response, receive a bearer token (pre-auth)
 *   GET  /api/status                 -  Daemon status summary (requires a valid token)
 *   GET  /api/stream/:processId      -  SSE stream of one process's PTY output/exit
 *                                        (requires a valid bearer token AND a
 *                                        `?ticket=` minted by the signature-required
 *                                        RPC `agent.streamTicket` — see "Streaming
 *                                        authorization" below; no unfiltered/firehose
 *                                        mode exists)
 *   GET  /                           -  Serves Studio static frontend (index.html)
 *   GET  /assets/*                   -  Serves static assets
 *
 * Auth (fail-closed):
 *   Every /rpc and /api/* request EXCEPT the pairing endpoints (see PRE_AUTH_ROUTES)
 *   requires `Authorization: Bearer <token>`, where the token's SHA-256 hash matches a
 *   durable, unexpired, unrevoked row in `gateway_tokens`. There is no pre-pairing
 *   bypass: a never-paired daemon refuses every RPC (including agent.spawn / agent.stop).
 *
 * Pairing (challenge-response, secret never crosses the wire):
 *   GET /api/pair returns a nonce; the operator computes HMAC-SHA256(secret, nonce) with
 *   the 32-byte secret from the 0600 file in the daemon data dir and POSTs it back. The
 *   server verifies against the same file secret with a timing-safe comparison, then mints
 *   a durable bearer token. The stored DB hash (gateway_bootstrap) detects file tampering
 *   or substitution; the file itself is the HMAC key.
 *
 * Streaming authorization (GAP-421 guardrail-2 remediation, B1):
 *   The bearer token above is a TRANSPORT credential — it proves this HTTP client
 *   paired with the daemon, nothing about which agent it is or what PTY content it
 *   may read. `agent.output` (the poll-based equivalent) requires a verified Ed25519
 *   signer AND `owner_agent === callerAgentId`; `/api/stream` enforces the identical
 *   check via a short-lived, single-use, processId-bound ticket minted by the
 *   signature-required RPC `agent.streamTicket` (spawn.ts). A bearer token alone
 *   cannot open a stream, and there is no way to subscribe to more than one
 *   `processId` per ticket.
 *
 * Off by default: the daemon only constructs this gateway when `httpPort` is
 * configured to a non-zero value (see `startDaemon` in server.ts). No config,
 * no listener.
 */

/** Tunable auth parameters (defaults applied in the constructor). */
export interface AuthTuning {
  /** Bearer-token lifetime in ms (default: 90 days). */
  tokenTtlMs?: number;
  /** Pairing-nonce lifetime in ms (default: 2 minutes). */
  nonceTtlMs?: number;
  /** Failed pairing attempts per source before lockout kicks in (default: 5). */
  lockoutThreshold?: number;
  /** Base lockout duration in ms; doubles per failure past the threshold (default: 60s). */
  baseLockoutMs?: number;
  /** Ceiling on lockout duration in ms (default: 1 hour). */
  maxLockoutMs?: number;
  /** Global failed-attempt ceiling before a fleet-wide cooldown (default: 100). */
  globalFailureCeiling?: number;
  /** Clock source (default: Date.now); injectable for deterministic tests. */
  now?: () => number;
}

export interface HttpGatewayConfig {
  /** TCP port to listen on (0 = disabled; the daemon never constructs this class in that case) */
  port: number;
  /** Bind address */
  host: string;
  /** Path to Studio static build directory (optional  -  disables static serving if absent) */
  staticDir?: string | null;
  /** The daemon's PGlite handle — dispatchRpc and the gateway-store both read/write it */
  db: PGlite;
  /** Absolute path to the 0600 bootstrap pairing secret file */
  secretPath: string;
  /** Optional auth tuning (TTLs, lockout, clock) */
  authTuning?: AuthTuning;
}

/**
 * The EXACT set of routes served before authentication. Everything else under
 * `/rpc` and `/api/*` requires a valid bearer token. Exported so the allowlist is a
 * verifiable constant rather than emergent routing behavior (spec §7 R3).
 */
export const PRE_AUTH_ROUTES: ReadonlyArray<{ readonly method: string; readonly path: string }> = [
  { method: 'GET', path: '/api/pair' },
  { method: 'POST', path: '/api/pair' },
];

/** Whether a (method, path) pair is served without authentication. */
export function isPreAuthRoute(method: string, path: string): boolean {
  for (const route of PRE_AUTH_ROUTES) {
    if (route.method === method && route.path === path) return true;
  }
  return false;
}

const DEFAULT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_NONCE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_LOCKOUT_THRESHOLD = 5;
const DEFAULT_BASE_LOCKOUT_MS = 60 * 1000;
const DEFAULT_MAX_LOCKOUT_MS = 60 * 60 * 1000;
const DEFAULT_GLOBAL_FAILURE_CEILING = 100;
const MAX_PENDING_NONCES = 256;
// Ported from the harnesses gateway's #1975 guardrail-2 verdict: bounded so a
// persistent create/delete race on the secret file cannot livelock startup.
// DoS-only concern (O_EXCL + O_NOFOLLOW still hold, so no secret can be
// substituted); defense-in-depth, not a new attack surface.
const MAX_INIT_AUTH_ATTEMPTS = 5;
const SECRET_BYTES = 32;
const NONCE_BYTES = 32;
const TOKEN_BYTES = 32;
/** Host header values treated as loopback for the Host-validation check (S3). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
/** Cap on concurrent SSE connections (S6) — each holds a 30s keepalive timer. */
const MAX_SSE_CONNECTIONS = 64;
/** 1 MiB cap on /rpc bodies, measured in UTF-8 bytes (S1, mirrors server.ts maxLineBytes). */
const MAX_RPC_BODY_BYTES = 1_048_576;
/** 1 KiB cap on /api/pair bodies, measured in UTF-8 bytes (S1). */
const MAX_PAIR_BODY_BYTES = 1024;

/** MIME types for static file serving */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

interface RateLimiterConfig {
  now: () => number;
  lockoutThreshold: number;
  baseLockoutMs: number;
  maxLockoutMs: number;
  globalCeiling: number;
}

/**
 * Per-source failed-attempt tracker for the pairing endpoint: exponential backoff
 * with a lockout ceiling, plus a coarse global cooldown. In-memory only (a pairing
 * flood is transient and pre-auth); state resets on restart per spec §D5/§7 R6.
 */
export class PairingRateLimiter {
  private readonly perSource = new Map<string, { failures: number; lockedUntil: number }>();
  private globalFailures = 0;
  private globalLockedUntil = 0;

  constructor(private readonly cfg: RateLimiterConfig) {}

  /** Milliseconds until this source (or the whole gateway) may attempt again; 0 if clear. */
  retryAfterMs(source: string): number {
    const now = this.cfg.now();
    if (now < this.globalLockedUntil) return this.globalLockedUntil - now;
    const rec = this.perSource.get(source);
    if (rec && now < rec.lockedUntil) return rec.lockedUntil - now;
    return 0;
  }

  /** Clear a source's failure history after a successful pairing. */
  recordSuccess(source: string): void {
    this.perSource.delete(source);
  }

  /** Record a failed attempt; returns the resulting lockout for this source and the global state. */
  recordFailure(source: string): { failures: number; lockMs: number; globalTripped: boolean } {
    const now = this.cfg.now();
    const rec = this.perSource.get(source) ?? { failures: 0, lockedUntil: 0 };
    rec.failures += 1;
    let lockMs = 0;
    if (rec.failures >= this.cfg.lockoutThreshold) {
      const over = rec.failures - this.cfg.lockoutThreshold;
      lockMs = Math.min(this.cfg.baseLockoutMs * 2 ** over, this.cfg.maxLockoutMs);
      rec.lockedUntil = now + lockMs;
    }
    this.perSource.set(source, rec);

    this.globalFailures += 1;
    let globalTripped = false;
    if (this.globalFailures >= this.cfg.globalCeiling) {
      this.globalLockedUntil = now + this.cfg.baseLockoutMs;
      this.globalFailures = 0;
      globalTripped = true;
    }
    return { failures: rec.failures, lockMs, globalTripped };
  }
}

export class HttpGateway {
  private server: Server;
  private readonly config: HttpGatewayConfig;

  /** The 32-byte file secret (hex string) used to key pairing HMACs; null when unusable. */
  private bootstrapSecret: string | null = null;
  /** Outstanding single-use pairing nonces → expiry (ms epoch). */
  private readonly nonces = new Map<string, number>();
  private readonly rateLimiter: PairingRateLimiter;
  private readonly now: () => number;
  private readonly tokenTtlMs: number;
  private readonly nonceTtlMs: number;
  /** S6: bounds concurrent SSE connections. */
  private activeStreamCount = 0;

  constructor(config: HttpGatewayConfig) {
    this.config = config;
    const t = config.authTuning ?? {};
    this.now = t.now ?? (() => Date.now());
    this.tokenTtlMs = t.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.nonceTtlMs = t.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;
    this.rateLimiter = new PairingRateLimiter({
      now: this.now,
      lockoutThreshold: t.lockoutThreshold ?? DEFAULT_LOCKOUT_THRESHOLD,
      baseLockoutMs: t.baseLockoutMs ?? DEFAULT_BASE_LOCKOUT_MS,
      maxLockoutMs: t.maxLockoutMs ?? DEFAULT_MAX_LOCKOUT_MS,
      globalCeiling: t.globalFailureCeiling ?? DEFAULT_GLOBAL_FAILURE_CEILING,
    });
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  /** Absolute path to the bootstrap pairing secret file (never its value). */
  getSecretPath(): string {
    return this.config.secretPath;
  }

  /**
   * Prepare fail-closed auth state. Must run before start() serves requests.
   *
   * Reconciles the 0600 secret file with the persisted hash (gateway_bootstrap):
   *   - fresh (no file, no hash): generate a 32-byte 0600 secret and persist its hash.
   *   - fresh DB + existing file (§7 R5): re-hash the file into the new store.
   *   - file + matching hash: adopt the file secret as the HMAC key.
   *   - file present, hash mismatch (§D7): possible substitution  -  refuse new pairings.
   *   - file missing, hash on record (§D7): file removed  -  refuse new pairings (tokens still work).
   *   - permissive mode (§D7): group/other-readable  -  refuse to use it.
   */
  async initAuth(): Promise<void> {
    const secretPath = this.config.secretPath;
    const db = this.config.db;

    // Looped so a create-path race that loses to another process (EEXIST) falls
    // back to reading the winner's file rather than failing the daemon. Bounded
    // at MAX_INIT_AUTH_ATTEMPTS so a persistent create/delete race cannot
    // livelock startup.
    for (let attempt = 1; attempt <= MAX_INIT_AUTH_ATTEMPTS; attempt++) {
      const dbHash = await getBootstrapSecretHash(db);

      // Read path: open ONE fd with O_NOFOLLOW, then fstat + read that same fd.
      // No path is resolved twice, so a symlink or file swap after the open
      // cannot substitute an attacker-controlled key past the permission gate.
      let fd: number;
      try {
        fd = openSync(secretPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // File genuinely absent: fall through to the missing/create paths.
        } else {
          this.bootstrapSecret = null;
          if (code === 'ELOOP') {
            this.logAuth(
              `bootstrap secret at ${secretPath} is a symlink; refusing to follow it (possible substitution)`,
            );
          } else {
            this.logAuth(
              `cannot open bootstrap secret at ${secretPath} (${code ?? 'unknown error'}); refusing new pairings`,
            );
          }
          return;
        }

        // ENOENT: file missing.
        if (dbHash !== null) {
          this.bootstrapSecret = null;
          this.logAuth(
            `bootstrap secret file ${secretPath} is missing but a hash is on record; refusing new pairings (existing tokens still work). Regenerate the file to re-enable pairing.`,
          );
          return;
        }

        // Truly fresh: exclusively create the fail-closed bootstrap secret. The
        // 'wx' flag (O_EXCL) refuses a pre-planted file or symlink, and mode
        // 0600 is applied atomically on creation.
        mkdirSync(dirname(secretPath), { recursive: true });
        const secret = randomBytes(SECRET_BYTES).toString('hex');
        try {
          writeFileSync(secretPath, secret, { flag: 'wx', mode: 0o600 });
        } catch (createErr) {
          if ((createErr as NodeJS.ErrnoException).code === 'EEXIST') {
            // Another process created the file between our open and write; loop
            // back to read it rather than failing.
            continue;
          }
          throw createErr;
        }
        await putBootstrapSecretHash(db, sha256Hex(secret));
        this.bootstrapSecret = secret;
        this.logAuth(`generated a new bootstrap pairing secret at ${secretPath} (mode 0600)`);
        return;
      }

      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) {
          this.bootstrapSecret = null;
          this.logAuth(
            `bootstrap secret at ${secretPath} is not a regular file; refusing to use it`,
          );
          return;
        }
        const mode = stat.mode & 0o777;
        if ((mode & 0o077) !== 0) {
          this.bootstrapSecret = null;
          this.logAuth(
            `bootstrap secret at ${secretPath} is group/other-accessible (mode ${mode.toString(8)}); refusing to use it  -  run: chmod 600 ${secretPath}`,
          );
          return;
        }
        const contents = readFileSync(fd, 'utf8').trim();
        if (contents.length === 0) {
          this.bootstrapSecret = null;
          this.logAuth(`bootstrap secret file at ${secretPath} is empty; refusing new pairings`);
          return;
        }
        const fileHash = sha256Hex(contents);
        if (dbHash === null) {
          await putBootstrapSecretHash(db, fileHash);
          this.bootstrapSecret = contents;
          this.logAuth('adopted an existing bootstrap secret file into a fresh store');
        } else if (dbHash === fileHash) {
          this.bootstrapSecret = contents;
        } else {
          this.bootstrapSecret = null;
          this.logAuth(
            `bootstrap secret at ${secretPath} does not match the recorded hash (possible substitution); refusing new pairings until it is regenerated`,
          );
        }
        return;
      } finally {
        closeSync(fd);
      }
    }

    this.bootstrapSecret = null;
    this.logAuth(
      `bootstrap secret initialization at ${secretPath} did not converge after ${MAX_INIT_AUTH_ATTEMPTS} attempts (persistent create/delete race); refusing new pairings`,
    );
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, () => resolve());
      this.server.once('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** The bound TCP port (useful when constructed with port 0). */
  getPort(): number {
    const addr = this.server.address();
    return addr && typeof addr === 'object' ? addr.port : this.config.port;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // Host validation (S3, DNS-rebinding defense-in-depth). Checked before
      // anything else, including the pre-auth pairing routes — rebinding
      // specifically targets those, since they need no bearer token.
      if (!this.isAllowedHost(req.headers.host)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Invalid Host header' }));
        return;
      }

      // CORS is withheld from the pairing routes (S3): a page the operator
      // merely has open can otherwise reach GET/POST /api/pair cross-origin
      // pre-auth and burn the nonce pool / trip the lockout. It cannot forge
      // the HMAC without the file secret, so this is a DoS hardening, not an
      // auth-bypass fix. Every other route still needs a bearer token, which
      // a cross-origin page does not have.
      const isPairingPath = path === '/api/pair';
      if (!isPairingPath) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      }

      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // API / RPC namespace  -  fail-closed except the explicit pairing allowlist.
      if (path === '/rpc' || path.startsWith('/api/')) {
        if (!(isPreAuthRoute(method, path) || (await this.checkAuth(req, res)))) {
          return;
        }

        if (path === '/api/pair' && method === 'GET') {
          this.handleIssueNonce(res);
          return;
        }
        if (path === '/api/pair' && method === 'POST') {
          this.handlePair(req, res);
          return;
        }
        if (path === '/rpc' && method === 'POST') {
          this.handleRpc(req, res);
          return;
        }
        if (path === '/api/status') {
          this.handleStatus(res);
          return;
        }
        if (path.startsWith('/api/stream') && method === 'GET') {
          // Mandatory processId (B1: no wildcard/firehose mode) + the
          // signature-required ticket minted by agent.streamTicket.
          const processId = path.split('/')[3] ?? null;
          const ticket = url.searchParams.get('ticket');
          this.handleStream(req, res, processId, ticket);
          return;
        }

        jsonResponse(res, 404, { error: 'Not found' });
        return;
      }

      // Static file serving (Studio SPA shell  -  carries no data without a token).
      this.handleStatic(path, res);
    } catch (err) {
      this.logAuth(`request handling error: ${err instanceof Error ? err.message : 'unknown'}`);
      if (!res.headersSent) jsonResponse(res, 500, { error: 'Internal error' });
    }
  }

  /**
   * S3: reject requests whose Host header doesn't match the bound interface,
   * to blunt DNS rebinding against the pre-auth pairing routes. When bound to
   * loopback (the default), only loopback Host values are accepted. A
   * non-loopback bind (the operator opted into remote exposure) only
   * requires a present, parseable Host — a full allowlist would need
   * operator-supplied config this class does not have.
   */
  private isAllowedHost(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      return false;
    }
    if (LOOPBACK_HOSTS.has(this.config.host)) {
      return LOOPBACK_HOSTS.has(hostname);
    }
    return hostname.length > 0;
  }

  /** Verify `Authorization: Bearer <token>` against the durable token store. */
  private async checkAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const authHeader = req.headers.authorization ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      jsonResponse(res, 401, { error: 'Authorization required' });
      return false;
    }

    const presented = authHeader.slice(7);
    if (presented.length === 0) {
      jsonResponse(res, 401, { error: 'Authorization required' });
      return false;
    }

    const presentedHash = sha256Hex(presented);
    const row = await findValidToken(this.config.db, presentedHash);
    if (!row) {
      jsonResponse(res, 401, { error: 'Invalid or expired token' });
      return false;
    }

    // The store matched on hash equality; a constant-time re-check keeps token
    // verification timing-independent even if that predicate ever loosens.
    const a = Buffer.from(presentedHash, 'hex');
    const b = Buffer.from(row.token_hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      jsonResponse(res, 401, { error: 'Invalid or expired token' });
      return false;
    }

    return true;
  }

  /** GET /api/pair  -  issue a single-use, short-lived pairing nonce. */
  private handleIssueNonce(res: ServerResponse): void {
    this.pruneNonces();
    if (this.nonces.size >= MAX_PENDING_NONCES) {
      jsonResponse(res, 503, { error: 'Too many pending pairings; try again shortly' });
      return;
    }
    const nonce = randomBytes(NONCE_BYTES).toString('hex');
    this.nonces.set(nonce, this.now() + this.nonceTtlMs);
    jsonResponse(res, 200, { nonce, expiresIn: Math.floor(this.nonceTtlMs / 1000) });
  }

  private pruneNonces(): void {
    const now = this.now();
    for (const [nonce, expiresAt] of this.nonces) {
      if (expiresAt <= now) this.nonces.delete(nonce);
    }
  }

  /** POST /api/pair  -  verify an HMAC challenge response and mint a durable token. */
  private handlePair(req: IncomingMessage, res: ServerResponse): void {
    const source = req.socket.remoteAddress ?? 'unknown';
    const wait = this.rateLimiter.retryAfterMs(source);
    if (wait > 0) {
      this.logAuth(
        `pairing attempt from a locked-out source; ${Math.ceil(wait / 1000)}s remaining`,
      );
      jsonResponse(res, 429, { error: 'Too many attempts', retryAfter: Math.ceil(wait / 1000) });
      return;
    }

    // S1: accumulate raw Buffers and cap on UTF-8 BYTES, not string length
    // (which double-counts under UTF-16 for astral characters and can also
    // undercount multibyte BMP characters against the intended byte budget).
    // Decoding once at the end also avoids splitting a multibyte character
    // across a chunk boundary. S2: `rejected` stops a second, already-
    // buffered chunk from re-entering writeHead after req.destroy().
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_PAIR_BODY_BYTES) {
        rejected = true;
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      void this.completePair(res, Buffer.concat(chunks).toString('utf8'), source);
    });
  }

  private async completePair(res: ServerResponse, body: string, source: string): Promise<void> {
    if (this.bootstrapSecret === null) {
      // §D7 refusal state  -  a server condition, not the client's fault; do not penalize the source.
      this.logAuth('pairing requested but the bootstrap secret is unavailable; refusing');
      jsonResponse(res, 503, { error: 'Pairing is disabled' });
      return;
    }

    let nonce: string;
    let hmac: string;
    let label: string | null = null;
    try {
      const parsed = JSON.parse(body) as { nonce?: unknown; hmac?: unknown; label?: unknown };
      if (typeof parsed.nonce !== 'string' || typeof parsed.hmac !== 'string') {
        jsonResponse(res, 400, { error: 'nonce and hmac are required' });
        return;
      }
      nonce = parsed.nonce;
      hmac = parsed.hmac;
      if (typeof parsed.label === 'string') label = parsed.label.slice(0, 128);
    } catch {
      jsonResponse(res, 400, { error: 'Invalid JSON' });
      return;
    }

    // Consume the nonce (single-use): remove it before verifying so it cannot be replayed,
    // whether the attempt succeeds or fails.
    const nonceExpiry = this.nonces.get(nonce);
    this.nonces.delete(nonce);
    if (nonceExpiry === undefined || nonceExpiry <= this.now()) {
      this.registerPairFailure(source, 'unknown or expired nonce');
      jsonResponse(res, 403, { error: 'Invalid or expired nonce' });
      return;
    }

    const expected = createHmac('sha256', this.bootstrapSecret).update(nonce).digest();
    const presented = Buffer.from(hmac, 'hex');
    const ok = expected.length === presented.length && timingSafeEqual(expected, presented);
    if (!ok) {
      this.registerPairFailure(source, 'incorrect pairing response');
      jsonResponse(res, 403, { error: 'Invalid pairing response' });
      return;
    }

    this.rateLimiter.recordSuccess(source);

    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const expiresAt = new Date(this.now() + this.tokenTtlMs).toISOString();
    await insertToken(this.config.db, { tokenHash: sha256Hex(token), expiresAt, label });
    await pruneExpiredTokens(this.config.db);
    this.logAuth('issued a new bearer token via successful pairing');
    jsonResponse(res, 200, { token, expiresAt });
  }

  private registerPairFailure(source: string, reason: string): void {
    const { failures, lockMs, globalTripped } = this.rateLimiter.recordFailure(source);
    const lockNote = lockMs > 0 ? `; locked out ${Math.ceil(lockMs / 1000)}s` : '';
    this.logAuth(`pairing failure from ${source} (${reason}); failures=${failures}${lockNote}`);
    if (globalTripped) {
      this.logAuth('global pairing-failure ceiling reached; applying a global cooldown');
    }
  }

  /** GET /api/status  -  daemon status summary (auth required). */
  private handleStatus(res: ServerResponse): void {
    jsonResponse(res, 200, {
      daemon: 'revdev-daemon',
      pid: process.pid,
      uptime: process.uptime(),
    });
  }

  /**
   * POST /rpc  -  proxy JSON-RPC through dispatchRpc, the SAME authorization
   * path the Unix socket uses (GAP-421 wire path §1). Each HTTP request gets
   * a fresh SocketContext: HTTP is stateless, so per-call identity comes from
   * an embedded `x-revdev-signature` envelope or `params.actorAgentId` inside
   * the request body, never a persisted per-connection binding.
   */
  private handleRpc(req: IncomingMessage, res: ServerResponse): void {
    // S1/S2: same byte-accumulation + single-reject pattern as handlePair.
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_RPC_BODY_BYTES) {
        rejected = true;
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      void this.completeRpc(res, Buffer.concat(chunks).toString('utf8'));
    });
  }

  private async completeRpc(res: ServerResponse, body: string): Promise<void> {
    let parsed: RpcRequest;
    try {
      parsed = JSON.parse(body) as RpcRequest;
    } catch {
      jsonResponse(res, 200, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      } satisfies RpcResponse);
      return;
    }

    const ctx: SocketContext = {
      agentId: null,
      agentName: null,
      boundVia: null,
      keyOrigin: null,
      verifiedSignature: null,
      preSignatureAgentId: null,
      preSignatureAgentName: null,
      preSignatureBoundVia: null,
    };
    const response = await dispatchRpc(parsed, this.config.db, ctx);
    jsonResponse(res, 200, response);
  }

  /**
   * GET /api/stream/:processId?ticket=...  -  SSE for one process's PTY
   * output and exit events (GAP-421 guardrail-2 remediation, B1).
   *
   * The bearer token already checked upstream (checkAuth) is a TRANSPORT
   * credential: it proves this HTTP client paired with the daemon, nothing
   * about which agent it is or what it may read. That is not sufficient
   * here — `agent.output` requires a verified Ed25519 signer AND
   * `owner_agent === callerAgentId`, and this route must enforce the same.
   * The `ticket` query param is minted only by the signature-required RPC
   * `agent.streamTicket` (spawn.ts), which re-runs that exact ownership
   * check. `redeemStreamTicket` is single-use and processId-bound, so:
   *   - no ticket, or a ticket for a different processId → 401, no stream.
   *   - no processId in the path at all → 400 (there is no "stream
   *     everything" mode; the pre-port harnesses SSE endpoint had no
   *     Studio consumer, so there is no back-compat contract to preserve
   *     for an unfiltered subscribe).
   */
  private handleStream(
    req: IncomingMessage,
    res: ServerResponse,
    processId: string | null,
    ticket: string | null,
  ): void {
    if (!processId) {
      jsonResponse(res, 400, { error: 'processId is required' });
      return;
    }
    if (!ticket) {
      jsonResponse(res, 401, { error: 'A stream ticket is required (call agent.streamTicket)' });
      return;
    }
    const redeemed = redeemStreamTicket(ticket, processId);
    if (!redeemed) {
      jsonResponse(res, 401, { error: 'Invalid, expired, or already-used stream ticket' });
      return;
    }

    // S6: bound concurrent SSE connections. Checked AFTER ticket redemption
    // (which is itself rate-limited by requiring a fresh signed RPC call
    // per attempt) so an unauthenticated client cannot exhaust the cap.
    if (this.activeStreamCount >= MAX_SSE_CONNECTIONS) {
      jsonResponse(res, 503, { error: 'Too many concurrent streams; try again shortly' });
      return;
    }
    this.activeStreamCount++;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send initial keepalive
    res.write(': connected\n\n');

    // S6: a stalled consumer's kernel socket buffer fills, res.write()
    // returns false, and Node queues writes in unbounded userspace memory
    // behind it. Drop further frames for this connection until 'drain'
    // fires rather than buffering without bound — documented lossy
    // behavior for a slow reader, not a correctness requirement (SSE has
    // no delivery guarantee).
    let backpressured = false;
    res.on('drain', () => {
      backpressured = false;
    });

    const onOutput = (evt: AgentOutputEvent): void => {
      if (evt.processId !== processId || backpressured) return;
      if (!res.write(`event: output\ndata: ${JSON.stringify(evt)}\n\n`)) backpressured = true;
    };

    const onExit = (evt: AgentExitEvent): void => {
      if (evt.processId !== processId) return;
      res.write(`event: exit\ndata: ${JSON.stringify(evt)}\n\n`);
    };

    agentEvents.on('output', onOutput);
    agentEvents.on('exit', onExit);

    // Keepalive every 30s to prevent proxy/firewall timeouts
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 30_000);

    // Cleanup on client disconnect
    req.on('close', () => {
      this.activeStreamCount--;
      clearInterval(keepalive);
      agentEvents.off('output', onOutput);
      agentEvents.off('exit', onExit);
    });
  }

  /** Serve static files from the Studio build directory */
  private handleStatic(urlPath: string, res: ServerResponse): void {
    if (!this.config.staticDir) {
      jsonResponse(res, 404, { error: 'Static serving not configured' });
      return;
    }

    // Default to index.html for SPA routing
    const filePath = urlPath === '/' ? '/index.html' : urlPath;

    // Security: prevent directory traversal
    const normalized = normalize(filePath);
    if (normalized.includes('..')) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

    const fullPath = join(this.config.staticDir, normalized);

    // If file doesn't exist, serve index.html (SPA fallback)
    const targetPath =
      existsSync(fullPath) && statSync(fullPath).isFile()
        ? fullPath
        : join(this.config.staticDir, 'index.html');

    if (!existsSync(targetPath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = extname(targetPath);
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    createReadStream(targetPath).pipe(res);
  }

  private logAuth(message: string): void {
    process.stderr.write(`[http-gateway auth] ${message}\n`);
  }
}

/** SHA-256 hex digest of a string. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Helper to send a JSON response */
function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// gateway.revokeToken (S5) is registered in gateway-rpc.ts, not here — see
// that file's docblock for why it cannot live in this module.
