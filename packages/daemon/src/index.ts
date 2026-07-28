/**
 * @revdev/daemon — Harness Daemon for RevDev.
 *
 * The daemon is the coordination brain: it manages AI agent sessions,
 * PTY processes, inter-agent messaging, task coordination, file reservations,
 * and the merge pipeline.
 *
 * Transport:
 *   - Local: Unix socket (~/.local/share/revealui/harness.sock)
 *   - Remote (optional, off by default): an in-process HTTP gateway with
 *     fail-closed challenge-response pairing (GET/POST /api/pair). Ported
 *     from `@revealui/harnesses` `server/http-gateway.ts` into this package
 *     (GAP-421 daemon-ownership ADR) — every /rpc and /api/* request runs
 *     through the same `dispatchRpc` authorization path as the socket.
 *     Configure `httpPort` (0 = disabled, the default) to enable it.
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
export {
  HttpGateway,
  type HttpGatewayConfig,
  isPreAuthRoute,
  PRE_AUTH_ROUTES,
} from './http-gateway.js';
export { checkLicense, LICENSE_TIERS, type LicenseTier } from './license.js';
export {
  dispatchRpc,
  listRegisteredMethods,
  type RpcRequest,
  type RpcResponse,
  registerHandler,
  startDaemon,
} from './server.js';
export {
  evaluateToolAction,
  type GuardVerdict,
  initToolGuard,
  TOOL_GUARD_DENIED,
  type ToolAction,
  ToolGuardError,
} from './tool-guard/index.js';
export { loadPatterns, manifestHash, type PatternManifest } from './tool-guard/patterns.js';

// Side-effect imports: register built-in handler groups.
import './inference.js';
import './vcs.js';
import './filegit.js';
import './agent.js';
// PTY-backed agent.spawn/stop/input/resize/output — overwrites the stubs
// in agent.js with real implementations. Must follow agent.js in import order.
import './spawn.js';
import './gateway-rpc.js';

export { DAEMON_DEFAULTS, type DaemonConfig } from './config.js';
export { SCHEMA_SQL } from './storage/schema.js';
