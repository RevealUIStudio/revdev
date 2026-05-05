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
 */

import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import './inference.js';
import './vcs.js';
import { DAEMON_DEFAULTS } from './config.js';
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

License tiers:
  free         Session management only
  pro          + agent spawning, merge pipeline, memory
  max          + inference management, advanced coordination
  enterprise   Full access, all features
`);
  process.exit(0);
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
  const child = spawn(process.execPath, [process.argv[1]!, ...childArgs], {
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
};

const pidFile = process.env.REVDEV_DAEMON_PID ?? DAEMON_DEFAULTS.pidFile;

console.log('');
console.log('  RevDev Daemon v0.1.0');
console.log('  ────────────────────');

const daemon = await startDaemon(config);

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
