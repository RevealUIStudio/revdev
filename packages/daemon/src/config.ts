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
};
