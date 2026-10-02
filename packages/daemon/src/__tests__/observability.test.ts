import type { PGlite } from '@electric-sql/pglite';
import { appMetrics, healthCheck, metrics } from '@revealui/core/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LicenseEvaluation } from '../license.js';
import {
  activeConnections,
  getPrometheusMetrics,
  getSystemHealth,
  initObservability,
  licenseExpiresTimestamp,
  licenseValid,
  onConnect,
  onDisconnect,
  recordLicenseMetrics,
  rpcCallsTotal,
  trackRpcCall,
} from '../observability.js';

afterEach(() => {
  healthCheck.unregister('pglite');
  healthCheck.unregister('memory');
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('daemon integration with published Core observability', () => {
  it('exports RPC labels and converts milliseconds to seconds', () => {
    const labels = { method: 'compatibility.ping', status: 'ok' };
    const before = rpcCallsTotal.get(labels);
    const beforeDuration = metrics.exportJSON().revdev_daemon_rpc_duration_seconds as {
      sum: number;
      count: number;
    };
    trackRpcCall(labels.method, 'ok', 250);

    expect(rpcCallsTotal.get(labels)).toBe(before + 1);
    expect(getPrometheusMetrics()).toContain(
      `revdev_daemon_rpc_calls_total{method="compatibility.ping",status="ok"} ${before + 1}`,
    );
    expect(getPrometheusMetrics()).toContain(
      `revdev_daemon_rpc_duration_seconds_sum ${beforeDuration.sum + 0.25}`,
    );
    expect(getPrometheusMetrics()).toContain(
      `revdev_daemon_rpc_duration_seconds_count ${beforeDuration.count + 1}`,
    );
  });

  it('clears license gauges when a licensed daemon becomes free', () => {
    const licensed: LicenseEvaluation = {
      tier: 'pro',
      valid: true,
      present: true,
      source: 'env',
      status: 'ok',
      expiresAt: 2_000_000_000,
      secondsRemaining: 20 * 24 * 60 * 60,
    };
    recordLicenseMetrics(licensed);
    expect(licenseValid.get()).toBe(1);
    expect(licenseExpiresTimestamp.get()).toBe(licensed.expiresAt);

    recordLicenseMetrics({
      tier: 'free',
      valid: false,
      present: false,
      source: 'none',
      status: 'absent',
      expiresAt: null,
      secondsRemaining: null,
    });
    expect(licenseValid.get()).toBe(0);
    expect(licenseExpiresTimestamp.get()).toBe(0);
  });

  it('balances daemon and Core socket connection gauges', () => {
    const before = activeConnections.get();
    const coreBefore = appMetrics.activeConnections.get({ type: 'socket' });
    onConnect();
    expect(activeConnections.get()).toBe(before + 1);
    expect(metrics.exportPrometheus()).toContain(
      `active_connections{type="socket"} ${coreBefore + 1}`,
    );
    onDisconnect();
    expect(activeConnections.get()).toBe(before);
    expect(metrics.exportPrometheus()).toContain(`active_connections{type="socket"} ${coreBefore}`);
  });

  it.each([true, false])('reports database readiness when query success is %s', async (success) => {
    vi.useFakeTimers();
    const query = success
      ? vi.fn().mockResolvedValue({ rows: [{ value: 1 }] })
      : vi.fn().mockRejectedValue(new Error('synthetic private database detail'));
    const database = { query } as unknown as PGlite;
    initObservability(database);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    const health = await getSystemHealth();
    expect(query).toHaveBeenCalledWith('SELECT 1');
    const pglite = health.checks.pglite;
    if (!pglite) throw new Error('PGlite health check was not registered');
    expect(pglite.status).toBe(success ? 'healthy' : 'unhealthy');
    if (!success) {
      expect(health.status).toBe('unhealthy');
      expect(pglite.message).toBe('PGlite query failed');
      expect(JSON.stringify(health)).not.toContain('synthetic private database detail');
    }
  });
});
