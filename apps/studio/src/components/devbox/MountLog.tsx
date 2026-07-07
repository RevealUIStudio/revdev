interface MountLogProps {
  entries: string[];
}

export default function MountLog({ entries }: MountLogProps) {
  return (
    <div className="rounded-lg border border-edge bg-surface-1 p-4">
      <h2 className="mb-2 text-sm font-medium text-fg">Log</h2>
      <div className="max-h-48 overflow-y-auto font-mono text-xs text-fg-muted">
        {entries.map((entry) => (
          <div key={entry} className="py-0.5">
            {entry}
          </div>
        ))}
      </div>
    </div>
  );
}
