import type { MountStatus } from '../../types';
import Card from '../ui/Card';

interface DriveInfoProps {
  mount: MountStatus;
}

export default function DriveInfo({ mount }: DriveInfoProps) {
  return (
    <Card variant="default" padding="md">
      <h2 className="text-sm font-medium text-fg">Drive Info</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-fg-subtle">Status</dt>
        <dd className={mount.mounted ? 'text-success' : 'text-fg-muted'}>
          {mount.mounted ? 'Mounted' : 'Not Mounted'}
        </dd>
        <dt className="text-fg-subtle">Mount Point</dt>
        <dd className="text-fg-muted">{mount.mount_point}</dd>
        {mount.device && (
          <>
            <dt className="text-fg-subtle">Device</dt>
            <dd className="font-mono text-fg-muted">{mount.device}</dd>
          </>
        )}
        {mount.size_total && (
          <>
            <dt className="text-fg-subtle">Total</dt>
            <dd className="text-fg-muted">{mount.size_total}</dd>
            <dt className="text-fg-subtle">Used</dt>
            <dd className="text-fg-muted">
              {mount.size_used} ({mount.use_percent})
            </dd>
            <dt className="text-fg-subtle">Available</dt>
            <dd className="text-fg-muted">{mount.size_available}</dd>
          </>
        )}
      </dl>
    </Card>
  );
}
