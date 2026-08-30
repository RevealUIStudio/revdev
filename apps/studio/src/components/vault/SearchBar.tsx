import { IconSearch } from '@revealui/presentation';
import Input from '../adapters/Input';

interface SearchBarProps {
  query: string;
  onChange: (query: string) => void;
}

export default function SearchBar({ query, onChange }: SearchBarProps) {
  return (
    <div className="relative">
      <IconSearch
        size="sm"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle"
      />
      <Input
        type="search"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search secrets..."
        className="pl-9"
      />
    </div>
  );
}
