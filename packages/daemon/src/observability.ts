/**
 * Daemon observability — metrics, health checks, and Prometheus export.
 *
 * Registers daemon-specific metrics (RPC calls, active sessions, PGlite health)
 * and exposes them via the `harness.health` RPC method and a future HTTP endpoint.
 */

import {
  createCustomHealthCheck,
  createMemoryHealthCheck,
  healthCheck,
  metrics,
  startMemoryMonitoring,
  updateActiveConnections,
} from '@revealui/core/observability';
import type { PGlite } from '@electric-sql/pglite';

// ---------------------------------------------------------------------------
// Daemon-specific metrics
// ---------------------------------------------------------------------------

/** Total RPC calls processed, labeled by method and status. */
export const rpcCallsTotal = metrics.counter(
  'revdev_daemon_rpc_calls_total',
  'Total RPC calls processed by the daemon',
  ['method', 'status'],
);

/** RPC call duration in seconds, labeled by method. */
export const rpcDuration = metrics.histogram(
  'revdev_daemon_rpc_duration_seconds',
  'RPC call duration in seconds',
  [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  ['method'],
);

/** Currently active socket connections. */
export const activeConnections = metrics.gauge(
  'revdev_daemon_connections_active',
  'Active socket connections',
);

/** Registered agent sessions. */
export const activeSessions = metrics.gauge(
  'revdev_daemon_sessions_active',
  'Registered agent sessions',
);

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

/**
 * Initialize observability. Call once after database is ready.
 * Registers health checks and starts memory monitoring.
 */
export function initObservability(db: PGlite): void {
  // PGlite health check — can the database respond?
  healthCheck.register(
    createCustomHealthCheck('pglite', async () => {
      try {
        await db.query('SELECT 1');
        return { status: 'healthy', duration: 0 };
      } catch {
        return { status: 'unhealthy', duration: 0, message: 'PGlite query failed' };
      }
    }, true),
  );

  // Memory health check — warn at 85% usage
  healthCheck.register(createMemoryHealthCheck(85));

  // Start background memory usage tracking (every 30s)
  startMemoryMonitoring(30_000);
}

/**
 * Track an RPC call (for metrics).
 * Call at the end of each RPC dispatch.
 */
export function trackRpcCall(method: string, status: 'ok' | 'error', durationMs: number): void {
  rpcCallsTotal.inc(1, { method, status });
  rpcDuration.observe(durationMs / 1000, { method });
}

/** Increment active connection count (call on socket connect). */
export function onConnect(): void {
  activeConnections.inc();
  updateActiveConnections('socket', 1);
}

/** Decrement active connection count (call on socket close). */
export function onDisconnect(): void {
  activeConnections.dec();
  updateActiveConnections('socket', -1);
}

/**
 * Get Prometheus-format metrics export string.
 * Can be exposed via RPC or HTTP endpoint.
 */
export function getPrometheusMetrics(): string {
  return metrics.exportPrometheus();
}

/**
 * Run all health checks and return system health.
 */
export async function getSystemHealth() {
  return await healthCheck.checkHealth();
}
