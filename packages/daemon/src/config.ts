/**
 * Daemon configuration defaults.
 */

export interface DaemonConfig {
  /** Unix socket path for local IPC */
  socketPath: string;
  /** Data directory for PGlite database */
  dataDir: string;
  /** HTTP gateway port (0 = disabled) */
  httpPort: number;
  /** HTTP gateway bind address */
  httpHost: string;
  /** Static file directory for HTTP gateway */
  httpStaticDir: string | null;
  /** PID file path */
  pidFile: string;
  /** Maximum memory for PGlite (in MB) */
  maxMemoryMb: number;
  /** Sessions older than this with no `ended_at` are auto-ended on each prune pass. */
  staleSessionDays: number;
  /** Sessions ended longer than this are hard-deleted on each prune pass. */
  hardDeleteDays: number;
  /** How often to run the periodic prune (ms). Set to 0 to disable. */
  pruneIntervalMs: number;
  /**
   * Maximum size in UTF-8 bytes of a single newline-delimited JSON-RPC
   * frame on a client socket. Two failure modes are guarded:
   *
   *   1. Unbounded-growth attack — a client streams bytes without a
   *      newline; the per-socket reassembly buffer would grow linearly.
   *      On overflow, the daemon emits a JSON-RPC -32700 parse-error
   *      with id null AND destroys the socket. The client must
   *      reconnect.
   *
   *   2. Oversized complete frame — a single chunk arrives containing
   *      a newline-terminated frame larger than the cap. The frame is
   *      rejected with -32700 but the socket stays open; the client
   *      framed the boundary correctly, they just sent too much data.
   *
   * Comparisons use `Buffer.byteLength(s, 'utf8')` so the cap is
   * enforced in real UTF-8 bytes (matching the documented "bytes"
   * semantics) rather than UTF-16 code units — otherwise multibyte
   * payloads (emoji, non-Latin text) bypass the intended protection.
   *
   * 1 MiB default is generous for any plausible RPC (largest legitimate
   * payloads are inference.chat / inference.generate prompts; even a
   * 250k-token prompt fits) and tight enough to defeat unbounded growth.
   */
  maxLineBytes: number;
  /**
   * Maximum wall-clock time (in ms) for a single git child-process spawn
   * inside the daemon (worktree.create / worktree.remove). Without this,
   * a runaway git command (credential prompt on a private base branch,
   * a corrupt object DB requiring fsck, a giant repo, a hung remote)
   * holds the daemon socket forever — SIGTERM to the daemon does not
   * propagate to the orphaned git child.
   *
   * On timeout, the daemon SIGTERMs the child via the per-call
   * AbortSignal passed to spawn(), waits briefly for clean exit, and
   * returns a structured error response. On daemon shutdown, all
   * in-flight git children get SIGTERM via a shared AbortController
   * aborted from server.close().
   *
   * 60 s default covers any healthy worktree create/remove against a
   * reasonable repo. Override via REVDEV_DAEMON_GIT_TIMEOUT_MS for
   * deployers with very large repos or slow filesystems.
   */
  gitTimeoutMs: number;
  /**
   * Maximum size in UTF-8 bytes of file/blob CONTENT returned inline by a
   * content-returning read (`file.read`, `git.diffContent`,
   * `git.readBlobAtHead`, `git.readBlobAtIndex`). The inbound `maxLineBytes`
   * cap only guards request frames; it does NOT bound a response the daemon
   * writes back. Without this, a multi-MB file would be serialized into a
   * single JSON-RPC response frame and shipped over the relay, blowing the
   * client's reassembly buffer.
   *
   * Above the cap the handler returns `{ tooLarge: true, bytes }` instead of
   * `content`; the editor falls back to a streamed / read-only view (P1/P2).
   * Measured pre-serialize on the raw bytes (JSON escaping can roughly double
   * the wire size, so this sits comfortably under `maxLineBytes`).
   *
   * 768 KiB default is generous for any source file an editor opens inline.
   */
  maxInlineReadBytes: number;
  /**
   * Maximum wall-clock time (in ms) the daemon's `close()` waits for
   * in-flight RPC handlers to complete before tearing down PGlite and
   * the Unix socket. Pre-this-flag, `db.close()` raced with active
   * `await db.query(...)` calls — a long handler (e.g. worktree.create
   * shelling out to git on a private base branch) could throw mid-query
   * if the database closed under it.
   *
   * Sequence inside close():
   *   1. Abort the daemon shutdown signal — this SIGTERMs every
   *      in-flight git child, etc., letting them error out fast.
   *   2. Stop accepting new connections.
   *   3. Drain — poll the active-handler counter for up to
   *      `shutdownGracePeriodMs`; resolve as soon as it hits zero.
   *   4. db.close() + unlink socket.
   *
   * If the deadline passes with handlers still running (rare — almost
   * everything either completes within milliseconds or honors the abort
   * signal), the daemon logs a warning naming the leftover count and
   * proceeds to db.close(). Default 5 s covers any realistic handler;
   * tune via REVDEV_DAEMON_SHUTDOWN_GRACE_MS for slower environments.
   */
  shutdownGracePeriodMs: number;
  /**
   * Path to the ROOT-OWNED trust anchor: a file listing the SHA-256
   * fingerprint(s) of client public keys allowed to enroll a CLIENT-supplied
   * identity (the Studio zero-9P model). One fingerprint per line; blank lines
   * and `#` comments ignored.
   *
   * Why root-owned: the daemon runs as the WSL user, and the threat is a host
   * process that `wsl.exe`-es in AS THAT SAME USER. Such a process could write
   * any user-owned file, so a user-writable anchor is forgeable — it would let
   * the attacker enroll its own key. Only a file the attacker cannot write
   * (root:root, e.g. 0644) is a real anchor. The install-time setup writes it
   * with sudo (see Studio daemon_ctl provisioning).
   *
   * Enrollment of a client-supplied key whose fingerprint is NOT listed here is
   * rejected fail-closed (-32004). DAEMON-MINTED identities (headless hooks,
   * no client key) never consult this file — their private key is generated
   * in-process and never handed out, so they are not spoofable by a host
   * process. Override the path via REVDEV_DAEMON_TRUSTED_CLIENT_FP (tests point
   * it at a fixture).
   */
  trustedClientFingerprintPath: string;
}

const homeDir = process.env.HOME ?? '/tmp';

export const DAEMON_DEFAULTS: DaemonConfig = {
  socketPath: `${homeDir}/.local/share/revealui/harness.sock`,
  dataDir: `${homeDir}/.local/share/revealui`,
  httpPort: 0,
  httpHost: '127.0.0.1',
  httpStaticDir: null,
  pidFile: `${homeDir}/.local/share/revealui/harness.pid`,
  maxMemoryMb: 512,
  staleSessionDays: 7,
  hardDeleteDays: 30,
  pruneIntervalMs: 60 * 60 * 1000, // 1 hour
  maxLineBytes: 1_048_576, // 1 MiB
  gitTimeoutMs: 60_000, // 60 s
  maxInlineReadBytes: 786_432, // 768 KiB
  shutdownGracePeriodMs: 5_000, // 5 s
  trustedClientFingerprintPath: '/etc/revdev/trusted-client-fingerprint',
};
