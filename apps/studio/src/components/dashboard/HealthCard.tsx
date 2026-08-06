/**
 * HealthCard — Shows production API health status from /health/ready.
 *
 * Displays overall status (healthy/degraded/unhealthy/unreachable)
 * and individual check results (database, memory, etc.).
 */

import { useHealth } from '../../hooks/use-health';
import type { HealthCheck } from '../../lib/health-api';
import StatusDot from '../adapters/StatusDot';

const STATUS_MAP = {
  healthy: { dot: 'ok', label: 'Healthy', color: 'text-success' },
  degraded: { dot: 'warn', label: 'Degraded', color: 'text-warning' },
  unhealthy: { dot: 'error', label: 'Unhealthy', color: 'text-error' },
  unreachable: { dot: 'off', label: 'Unreachable', color: 'text-fg-subtle' },
} as const;

const CHECK_DOT_MAP = {
  healthy: 'ok',
  degraded: 'warn',
  unhealthy: 'error',
} as const satisfies Record<HealthCheck['status'], 'ok' | 'warn' | 'error'>;

const CHECK_COLOR_MAP = {
  healthy: 'text-success',
  degraded: 'text-warning',
  unhealthy: 'text-error',
} as const satisfies Record<HealthCheck['status'], string>;

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function normalizeChecks(
  checks: Record<string, HealthCheck> | HealthCheck[] | undefined,
): HealthCheck[] {
  if (!checks) return [];
  if (Array.isArray(checks)) return checks;
  return Object.entries(checks).map(([name, check]) => ({
    ...check,
    name: check.name ?? name,
  }));
}

export default function HealthCard() {
  const { health, reachable, loading } = useHealth();

  if (loading && !health) {
    return (
      <div className="rounded-lg border border-edge bg-surface-1 p-4">
        <div className="h-5 w-20 animate-pulse rounded bg-surface-2" />
        <div className="mt-3 h-4 w-32 animate-pulse rounded bg-surface-2" />
      </div>
    );
  }

  const status = !reachable ? 'unreachable' : (health?.status ?? 'unreachable');
  const info = STATUS_MAP[status as keyof typeof STATUS_MAP] ?? STATUS_MAP.unreachable;
  const checks = normalizeChecks(health?.checks);

  return (
    <div className="rounded-lg border border-edge bg-surface-1 p-4">
      <div className="flex items-center gap-2">
        <StatusDot status={info.dot as 'ok' | 'warn' | 'error' | 'off'} size="md" decorative />
        <h3 className="text-sm font-medium text-fg">API Health</h3>
      </div>

      <p className={`mt-2 text-xs font-medium ${info.color}`}>{info.label}</p>

      {health?.uptime != null ? (
        <p className="mt-0.5 text-xs text-fg-subtle">Uptime: {formatUptime(health.uptime)}</p>
      ) : null}

      {checks.length > 0 ? (
        <div className="mt-2 space-y-1">
          {checks.map((check) => (
            <div key={check.name} className="flex items-center justify-between text-xs">
              <span className="text-fg-muted">{check.name}</span>
              <span className={`flex items-center gap-1 ${CHECK_COLOR_MAP[check.status]}`}>
                <StatusDot status={CHECK_DOT_MAP[check.status]} size="sm" decorative />
                {check.status}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
