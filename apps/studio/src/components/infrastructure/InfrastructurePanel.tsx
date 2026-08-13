import { useState } from 'react';
import { useHarness } from '../../hooks/use-harness';
import Button from '../adapters/Button';
import AppsPanel from '../apps/AppsPanel';
import DevBoxPanel from '../devbox/DevBoxPanel';
import DaemonPanel from './DaemonPanel';

type InfraTab = 'apps' | 'devbox' | 'daemon';

export default function InfrastructurePanel() {
  const [tab, setTab] = useState<InfraTab>('daemon');
  const { status } = useHarness();

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-edge">
        <TabButton label="Daemon" active={tab === 'daemon'} onClick={() => setTab('daemon')} />
        <TabButton label="App Launcher" active={tab === 'apps'} onClick={() => setTab('apps')} />
        <TabButton label="DevPod" active={tab === 'devbox'} onClick={() => setTab('devbox')} />
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'daemon' && <DaemonPanel harnessStatus={status} />}
        {tab === 'apps' && <AppsPanel />}
        {tab === 'devbox' && <DevBoxPanel />}
      </div>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={`-mb-px rounded-none border-b-2 px-4 py-2 text-sm font-medium ${
        active ? 'border-brand text-fg' : 'border-transparent text-fg-muted'
      }`}
    >
      {label}
    </Button>
  );
}
