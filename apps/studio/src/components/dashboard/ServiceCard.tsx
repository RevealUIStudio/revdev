import StatusDot from '../adapters/StatusDot';

interface ServiceCardProps {
  title: string;
  status: 'running' | 'stopped' | 'degraded';
  detail: string;
}

const statusMap = {
  running: 'ok',
  stopped: 'off',
  degraded: 'warn',
} as const;

export default function ServiceCard({ title, status, detail }: ServiceCardProps) {
  return (
    <div className="rounded-lg border border-edge bg-surface-1 p-4">
      <div className="flex items-center gap-2">
        <StatusDot status={statusMap[status]} size="md" />
        <h3 className="text-sm font-medium text-fg">{title}</h3>
      </div>
      <p className="mt-2 text-xs text-fg-muted">{detail}</p>
      <p className="mt-1 text-xs capitalize text-fg-subtle">{status}</p>
    </div>
  );
}
