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
 */

import "./inference.js";
import "./vcs.js";
import { startDaemon } from './server.js';
import { DAEMON_DEFAULTS } from './config.js';

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

License tiers:
  free         Session management only
  pro          + agent spawning, merge pipeline, memory
  max          + inference management, advanced coordination
  enterprise   Full access, all features
`);
  process.exit(0);
}

const config = {
  socketPath: process.env['REVDEV_DAEMON_SOCKET'] ?? DAEMON_DEFAULTS.socketPath,
  dataDir: process.env['REVDEV_DAEMON_DATA'] ?? DAEMON_DEFAULTS.dataDir,
};

console.log('');
console.log('  RevDev Daemon v0.1.0');
console.log('  ────────────────────');

const daemon = await startDaemon(config);

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    console.log(`\n[daemon] Received ${signal}, shutting down...`);
    await daemon.close();
    process.exit(0);
  });
}
