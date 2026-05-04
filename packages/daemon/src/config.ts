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
};
