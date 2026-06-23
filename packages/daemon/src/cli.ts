#!/usr/bin/env node
/**
 * RevDev Daemon CLI — starts the harness daemon.
 *
 * Usage:
 *   revdev-daemon            # Start in foreground
 *   revdev-daemon --detach   # Start detached, return immediately (GAP-152)
 *   revdev-daemon --help     # Show help
 *
 * Environment:
 *   REVEALUI_LICENSE_KEY     # License key (v2 Ed25519-signed)
 *   REVDEV_LICENSE_PUBLIC_KEY # Public key matching REVEALUI_LICENSE_KEY signature
 *   REVDEV_DAEMON_SOCKET     # Override socket path
 *   REVDEV_DAEMON_DATA       # Override data directory
 *   REVDEV_DAEMON_PID        # Override PID file path
 *   REVDEV_DAEMON_LOG        # Where stdout/stderr go in --detach mode (default: /tmp/revdev-daemon.log)
 *   REVDEV_DAEMON_MAX_LINE_BYTES  # Max bytes per JSON-RPC frame (default: 1_048_576 = 1 MiB)
 *   REVDEV_DAEMON_GIT_TIMEOUT_MS  # Max wall-clock per git spawn (default: 60_000 = 60 s)
 *   REVDEV_DAEMON_SHUTDOWN_GRACE_MS  # Max wait for in-flight handlers in close() (default: 5_000 = 5 s)
 */

import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import './inference.js';
import './vcs.js';
import { DAEMON_DEFAULTS } from './config.js';
import { LicenseConfigError, LicenseExpiredError } from './license.js';
import { startDaemon } from './server.js';

// Default log path for --detach mode. Use the user's data dir (mode 0700,
// already owned by the user — no symlink-attack surface) instead of
// /tmp/revdev-daemon.log (world-writable, predictable name → CodeQL
// "insecure temporary file" finding). Override with REVDEV_DAEMON_LOG.
const DEFAULT_DETACH_LOG = join(homedir(), '.local', 'share', 'revealui', 'daemon.log');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
RevDev Daemon — AI agent coordination runtime

Usage:
  revdev-daemon [options]
  revdev-daemon migrate [--status]

Commands:
  migrate        Apply pending schema migrations and exit (non-zero on
                 failure). With --status, report current/latest/pending
                 versions without applying anything. PGlite allows one
                 process per data dir — stop the daemon first, or point
                 REVDEV_DAEMON_DATA at the target copy.

Options:
  --help, -h     Show this help message
  --detach       Spawn a detached child daemon and exit immediately.
                 Logs go to REVDEV_DAEMON_LOG (default ~/.local/share/revealui/daemon.log).
                 The detached child runs in its own session (setsid) so it
                 survives the launching shell's exit. Idempotent — re-running
                 with --detach while a daemon is already bound will fail at
                 the listen() step with EADDRINUSE; the existing daemon is
                 untouched.

Environment:
  REVEALUI_LICENSE_KEY        License key (v2 Ed25519-signed; required for Pro features)
  REVDEV_LICENSE_PUBLIC_KEY   Public key for license verification
  REVDEV_DAEMON_SOCKET        Socket path (default: ${DAEMON_DEFAULTS.socketPath})
  REVDEV_DAEMON_DATA          Data directory (default: ${DAEMON_DEFAULTS.dataDir})
  REVDEV_DAEMON_PID           PID file path (default: ${DAEMON_DEFAULTS.pidFile})
  REVDEV_DAEMON_LOG           Log file for --detach mode (default: ~/.local/share/revealui/daemon.log)
  REVDEV_DAEMON_MAX_LINE_BYTES  Max bytes per JSON-RPC frame (default: ${DAEMON_DEFAULTS.maxLineBytes}, ~1 MiB)
  REVDEV_DAEMON_GIT_TIMEOUT_MS  Max wall-clock per git spawn (default: ${DAEMON_DEFAULTS.gitTimeoutMs} ms = ${DAEMON_DEFAULTS.gitTimeoutMs / 1000} s)
  REVDEV_DAEMON_SHUTDOWN_GRACE_MS  Max wait for in-flight handlers during close() (default: ${DAEMON_DEFAULTS.shutdownGracePeriodMs} ms = ${DAEMON_DEFAULTS.shutdownGracePeriodMs / 1000} s)

License tiers:
  free         Session management only
  pro          + agent spawning, merge pipeline, memory
  max          + inference management, advanced coordination
  enterprise   Full access, all features
`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log('revdev-daemon 0.1.0');
  process.exit(0);
}

// `migrate` subcommand — bring the schema to the latest version (or report
// status) without starting the daemon. PGlite is single-process per data
// dir: if the daemon currently holds it, this fails loudly instead of
// corrupting anything — stop the daemon first.
if (args[0] === 'migrate') {
  const dataDir = process.env.REVDEV_DAEMON_DATA ?? DAEMON_DEFAULTS.dataDir;
  const { PGlite } = await import('@electric-sql/pglite');
  const { MigrationError, migrate, migrationStatus } = await import('./storage/migrate.js');
  let db: InstanceType<typeof PGlite> | undefined;
  try {
    db = new PGlite(dataDir);
    if (args.includes('--status')) {
      const status = await migrationStatus(db);
      console.log(`[migrate] data dir: ${dataDir}`);
      console.log(`[migrate] schema version: ${status.current} (latest known: ${status.latest})`);
      if (status.pending.length === 0) {
        console.log('[migrate] pending: none');
      } else {
        for (const m of status.pending) {
          console.log(`[migrate] pending: ${m.version} (${m.name})`);
        }
      }
    } else {
      const result = await migrate(db);
      if (result.applied.length === 0) {
        console.log(`[migrate] schema already at version ${result.current} — nothing to apply`);
      } else {
        console.log(
          `[migrate] applied migration(s) ${result.applied.join(', ')} — schema now at version ${result.current}`,
        );
      }
    }
    await db.close();
    process.exit(0);
  } catch (err) {
    if (db) {
      await db.close().catch(() => {});
    }
    if (err instanceof MigrationError) {
      console.error(`[migrate] ${err.message}`);
    } else {
      console.error(
        `[migrate] failed: ${String(err)} — if the daemon is running it holds the PGlite data dir; stop it first (systemctl --user stop revdev-daemon)`,
      );
    }
    process.exit(1);
  }
}

// --detach: re-spawn ourselves in a new session, redirect stdio to a log,
// and exit the parent. The child runs the same script without --detach so
// it falls into the normal foreground codepath below.
if (args.includes('--detach')) {
  const logPath = process.env.REVDEV_DAEMON_LOG ?? DEFAULT_DETACH_LOG;
  // Ensure the parent dir exists (data dir may not have been created yet).
  // Mode 0o700 — owner-only, matching the rest of the daemon's data dir.
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  // Open the log file with O_APPEND. Pass its fd to the child as both
  // stdout (1) and stderr (2). stdin is /dev/null.
  const logFd = openSync(logPath, 'a');
  const childArgs = args.filter((a) => a !== '--detach');
  const entryScript = process.argv[1];
  if (!entryScript) {
    throw new Error('Cannot determine daemon entry script (process.argv[1] missing)');
  }
  const child = spawn(process.execPath, [entryScript, ...childArgs], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();
  console.log(`revdev-daemon detached: pid=${child.pid}, log=${logPath}`);
  process.exit(0);
}

function parsePositiveInt(envName: string, defaultValue: number): number {
  const raw = process.env[envName];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const config = {
  socketPath: process.env.REVDEV_DAEMON_SOCKET ?? DAEMON_DEFAULTS.socketPath,
  dataDir: process.env.REVDEV_DAEMON_DATA ?? DAEMON_DEFAULTS.dataDir,
  maxLineBytes: parsePositiveInt('REVDEV_DAEMON_MAX_LINE_BYTES', DAEMON_DEFAULTS.maxLineBytes),
  gitTimeoutMs: parsePositiveInt('REVDEV_DAEMON_GIT_TIMEOUT_MS', DAEMON_DEFAULTS.gitTimeoutMs),
  shutdownGracePeriodMs: parsePositiveInt(
    'REVDEV_DAEMON_SHUTDOWN_GRACE_MS',
    DAEMON_DEFAULTS.shutdownGracePeriodMs,
  ),
};

const pidFile = process.env.REVDEV_DAEMON_PID ?? DAEMON_DEFAULTS.pidFile;

console.log('');
console.log('  RevDev Daemon v0.1.0');
console.log('  ────────────────────');

let daemon: Awaited<ReturnType<typeof startDaemon>>;
try {
  daemon = await startDaemon(config);
} catch (err) {
  // Fail-closed license errors are operator-actionable, not crashes:
  // initLicenseGuard already logged the CRITICAL detail for an expired
  // license; surface a config error then exit non-zero with no stack trace.
  if (err instanceof LicenseExpiredError) {
    process.exit(1);
  }
  if (err instanceof LicenseConfigError) {
    console.error(`[license] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

// Write PID file so supervisors and Studio can find us
await mkdir(dirname(pidFile), { recursive: true });
await writeFile(pidFile, String(process.pid));
console.log(`[daemon] PID ${process.pid} written to ${pidFile}`);

// Graceful shutdown — clean up PID file and socket
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    console.log(`\n[daemon] Received ${signal}, shutting down...`);
    await daemon.close();
    await unlink(pidFile).catch(() => {});
    process.exit(0);
  });
}
