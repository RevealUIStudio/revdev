interface SearchBarProps {
  query: string;
  onChange: (query: string) => void;
}

export default function SearchBar({ query, onChange }: SearchBarProps) {
  return (
    <div className="relative">
      <svg
        className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
        aria-hidden="true"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </svg>
      <input
        type="search"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search secrets..."
        className="w-full rounded-md border border-edge bg-surface-2 py-2 pl-9 pr-4 text-sm text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none"
      />
    </div>
  );
}
