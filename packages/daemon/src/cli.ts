#!/usr/bin/env node
/**
 * RevDev Daemon CLI — starts the harness daemon.
 *
 * Usage:
 *   revdev-daemon            # Start with defaults
 *   revdev-daemon --help     # Show help
 *
 * Environment:
 *   REVEALUI_LICENSE_KEY     # License key (RVUI-<tier>-<hash>)
 *   REVDEV_DAEMON_SOCKET     # Override socket path
 *   REVDEV_DAEMON_DATA       # Override data directory
 *   REVDEV_DAEMON_PID        # Override PID file path
 */

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import './inference.js';
import './vcs.js';
import { DAEMON_DEFAULTS } from './config.js';
import { startDaemon } from './server.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
RevDev Daemon — AI agent coordination runtime

Usage:
  revdev-daemon [options]

Options:
  --help, -h     Show this help message

Environment:
  REVEALUI_LICENSE_KEY   License key (required for Pro features)
  REVDEV_DAEMON_SOCKET   Socket path (default: ${DAEMON_DEFAULTS.socketPath})
  REVDEV_DAEMON_DATA     Data directory (default: ${DAEMON_DEFAULTS.dataDir})
  REVDEV_DAEMON_PID      PID file path (default: ${DAEMON_DEFAULTS.pidFile})

License tiers:
  free         Session management only
  pro          + agent spawning, merge pipeline, memory
  max          + inference management, advanced coordination
  enterprise   Full access, all features
`);
  process.exit(0);
}

const config = {
  socketPath: process.env.REVDEV_DAEMON_SOCKET ?? DAEMON_DEFAULTS.socketPath,
  dataDir: process.env.REVDEV_DAEMON_DATA ?? DAEMON_DEFAULTS.dataDir,
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
