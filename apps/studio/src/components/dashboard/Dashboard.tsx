import { useStatusContext } from '../../hooks/use-status';
import Button from '../adapters/Button';
import ErrorAlert from '../adapters/ErrorAlert';
import PanelHeader from '../adapters/PanelHeader';
import HealthCard from './HealthCard';
import ServiceCard from './ServiceCard';
import SubscriptionCard from './SubscriptionCard';
import TierBadge from './TierBadge';
import WelcomeBanner from './WelcomeBanner';

export default function Dashboard() {
  const { system, mount, loading, error, refresh } = useStatusContext();

  if (loading && !system) {
    return <LoadingSkeleton />;
  }

  return (
    <div className="space-y-6">
      <PanelHeader
        title="Dashboard"
        action={
          <Button variant="secondary" onClick={refresh} loading={loading}>
            Refresh
          </Button>
        }
      />

      <WelcomeBanner />

      <ErrorAlert message={error} />

      {system ? (
        <div className="flex items-center gap-3">
          <TierBadge tier={system.tier} />
          <span className="text-sm text-fg-muted">
            {system.distribution} &mdash; systemd: {system.systemd_status}
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ServiceCard
          title="WSL"
          status={system?.wsl_running ? 'running' : 'stopped'}
          detail={system?.distribution ?? 'Unknown'}
        />
        <ServiceCard
          title="Studio Drive"
          status={mount?.mounted ? 'running' : 'stopped'}
          detail={
            mount?.mounted
              ? `${mount.size_used ?? '?'} / ${mount.size_total ?? '?'} (${mount.use_percent ?? '?'})`
              : 'Not mounted'
          }
        />
        <ServiceCard
          title="Systemd"
          status={
            system?.systemd_status === 'running'
              ? 'running'
              : system?.systemd_status === 'degraded'
                ? 'degraded'
                : 'stopped'
          }
          detail={system?.systemd_status ?? 'Unknown'}
        />
        <HealthCard />
        <SubscriptionCard />
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-7 w-32 animate-pulse rounded bg-surface-2" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-lg bg-surface-3" />
        ))}
      </div>
    </div>
  );
}
