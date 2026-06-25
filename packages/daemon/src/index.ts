/**
 * @revdev/daemon — Harness Daemon for RevDev.
 *
 * The daemon is the coordination brain: it manages AI agent sessions,
 * PTY processes, inter-agent messaging, task coordination, file reservations,
 * and the merge pipeline.
 *
 * Transport:
 *   - Local: Unix socket (~/.local/share/revealui/harness.sock)
 *   - Remote: HTTP gateway with pairing-code auth
 *   - Protocol: JSON-RPC 2.0 over newline-delimited JSON
 *
 * License: FSL-1.1-MIT (converts to MIT after 2 years)
 *
 * @packageDocumentation
 */

export {
  getLicenseState,
  guardRpcMethod,
  initLicenseGuard,
  licenseErrorResponse,
  type RpcGuardResult,
  refreshLicense,
} from './guard.js';
export { checkLicense, LICENSE_TIERS, type LicenseTier } from './license.js';
export { registerHandler, startDaemon } from './server.js';

// Side-effect imports: register built-in handler groups.
import './inference.js';
import './vcs.js';
import './filegit.js';

export { DAEMON_DEFAULTS, type DaemonConfig } from './config.js';
export { SCHEMA_SQL } from './storage/schema.js';
