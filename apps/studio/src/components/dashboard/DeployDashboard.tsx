import { useEffect, useRef, useState } from 'react';
import { getConfig } from '../../lib/config';
import { healthCheck } from '../../lib/deploy';
import type { StudioConfig } from '../../types';
import Button from '../adapters/Button';
import PanelHeader from '../adapters/PanelHeader';
import StatusDot from '../adapters/StatusDot';

type ServiceStatus = 'healthy' | 'degraded' | 'down' | 'checking';

interface ServiceState {
  label: string;
  url: string;
  status: ServiceStatus;
}

/** Health check interval in ms (60 seconds) */
const HEALTH_CHECK_INTERVAL_MS = 60_000;

function resolveStatus(code: number): ServiceStatus {
  if (code >= 200 && code < 300) return 'healthy';
  if (code >= 300 && code < 500) return 'degraded';
  return 'down';
}

async function runHealthChecks(
  current: ServiceState[],
  setServices: React.Dispatch<React.SetStateAction<ServiceState[]>>,
  setRefreshing: React.Dispatch<React.SetStateAction<boolean>>,
): Promise<void> {
  if (current.length === 0) return;

  setRefreshing(true);
  setServices((prev) => prev.map((s) => ({ ...s, status: 'checking' as const })));

  const results = await Promise.allSettled(
    current.map((s) => healthCheck(`${s.url}/health/ready`)),
  );

  setServices((prev) =>
    prev.map((s, i) => {
      const result = results[i];
      if (result.status === 'fulfilled') {
        return { ...s, status: resolveStatus(result.value) };
      }
      return { ...s, status: 'down' as const };
    }),
  );

  setRefreshing(false);
}

export default function DeployDashboard() {
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [services, setServices] = useState<ServiceState[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const servicesRef = useRef(services);
  servicesRef.current = services;

  useEffect(() => {
    void getConfig().then((cfg) => {
      setConfig(cfg);
      const domain = cfg.deploy?.domain;
      if (domain) {
        const initial: ServiceState[] = [
          { label: 'API', url: `https://api.${domain}`, status: 'checking' },
          { label: 'Admin', url: `https://admin.${domain}`, status: 'checking' },
          { label: 'Marketing', url: `https://${domain}`, status: 'checking' },
        ];
        setServices(initial);
        // Run initial health check
        void runHealthChecks(initial, setServices, setRefreshing);
      }
    });
  }, []);

  // Periodic health check every 60 seconds
  useEffect(() => {
    if (services.length === 0) return;

    const interval = setInterval(() => {
      void runHealthChecks(servicesRef.current, setServices, setRefreshing);
    }, HEALTH_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [services.length]);

  function handleRefresh() {
    void runHealthChecks(services, setServices, setRefreshing);
  }

  const domain = config?.deploy?.domain;
  const configLoaded = config !== null;

  return (
    <div className="flex flex-col gap-6">
      <PanelHeader
        title="Deploy Dashboard"
        action={
          <Button variant="secondary" onClick={handleRefresh} loading={refreshing}>
            Refresh
          </Button>
        }
      />

      {services.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {services.map((service) => (
            <HealthCard key={service.label} service={service} />
          ))}
        </div>
      ) : configLoaded ? (
        <p className="py-6 text-center text-xs text-fg-subtle">
          No services configured.{' '}
          <span className="text-fg-subtle">
            Add a deploy domain in settings to enable health monitoring.
          </span>
        </p>
      ) : null}

      {domain && (
        <div className="rounded-md border border-edge bg-surface-1/50 p-4">
          <p className="mb-3 text-xs font-medium text-fg-muted">Quick Links</p>
          <div className="flex flex-col gap-2">
            <QuickLink label="Admin Dashboard" url={`https://admin.${domain}/admin`} />
            <QuickLink label="API Docs" url={`https://api.${domain}/docs`} />
            <QuickLink label="Marketing Site" url={`https://${domain}`} />
          </div>
        </div>
      )}
    </div>
  );
}

const domainStatusMap: Record<ServiceStatus, 'ok' | 'warn' | 'error' | 'off'> = {
  healthy: 'ok',
  degraded: 'warn',
  down: 'error',
  checking: 'off',
};

const statusLabels: Record<ServiceStatus, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  down: 'Down',
  checking: 'Checking...',
};

function HealthCard({ service }: { service: ServiceState }) {
  return (
    <div className="rounded-lg border border-edge bg-surface-1/50 p-4">
      <div className="flex items-center gap-2 mb-2">
        <StatusDot
          status={domainStatusMap[service.status]}
          size="md"
          pulse={service.status === 'checking'}
          decorative
        />
        <span className="text-sm font-medium text-fg">{service.label}</span>
      </div>
      <p className="text-xs text-fg-subtle">{statusLabels[service.status]}</p>
      <p className="mt-1 text-xs font-mono text-fg-muted truncate">{service.url}</p>
    </div>
  );
}

function QuickLink({ label, url }: { label: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 text-sm text-brand-text hover:text-brand transition-colors"
    >
      <span>{'→'}</span>
      <span>{label}</span>
      <span className="font-mono text-xs text-fg-subtle">{url}</span>
    </a>
  );
}
