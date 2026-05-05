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
};
