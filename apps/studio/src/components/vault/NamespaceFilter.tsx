import Button from '../adapters/Button';

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
      <Button
        type="button"
        variant="ghost"
        onClick={() => onChange(null)}
        className={`justify-start rounded px-2 py-1.5 text-left text-sm ${
          active === null ? 'bg-surface-2 text-fg' : 'text-fg-muted'
        }`}
      >
        All
      </Button>
      {namespaces.map((ns) => (
        <Button
          key={ns}
          type="button"
          variant="ghost"
          onClick={() => onChange(ns)}
          className={`justify-start rounded px-2 py-1.5 text-left text-sm ${
            active === ns ? 'bg-surface-2 text-fg' : 'text-fg-muted'
          }`}
        >
          {ns}
        </Button>
      ))}
      {namespaces.length === 0 && <p className="px-2 py-1 text-xs text-fg-subtle">No namespaces</p>}
    </div>
  );
}
