interface NamespaceFilterProps {
  namespaces: string[];
  active: string | null;
  onChange: (ns: string | null) => void;
}

export default function NamespaceFilter({ namespaces, active, onChange }: NamespaceFilterProps) {
  return (
    <div className="flex w-44 flex-shrink-0 flex-col gap-0.5">
      <p className="mb-1 px-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">
        Namespaces
      </p>
      <button
        type="button"
        onClick={() => onChange(null)}
        className={`rounded px-2 py-1.5 text-left text-sm transition-colors ${
          active === null
            ? 'bg-surface-2 text-fg'
            : 'text-fg-muted hover:bg-surface-3 hover:text-fg'
        }`}
      >
        All
      </button>
      {namespaces.map((ns) => (
        <button
          key={ns}
          type="button"
          onClick={() => onChange(ns)}
          className={`rounded px-2 py-1.5 text-left text-sm transition-colors ${
            active === ns
              ? 'bg-surface-2 text-fg'
              : 'text-fg-muted hover:bg-surface-3 hover:text-fg'
          }`}
        >
          {ns}
        </button>
      ))}
      {namespaces.length === 0 && <p className="px-2 py-1 text-xs text-fg-subtle">No namespaces</p>}
    </div>
  );
}
