import type { TileDefinition } from '../../lib/tiles';
import TileIcon from './TileIcon';

interface TileProps {
  tile: TileDefinition;
  hidden?: boolean;
  editing?: boolean;
  running?: boolean;
  onLaunch: (tile: TileDefinition) => void;
  onToggle?: (tileId: string) => void;
}

export default function Tile({ tile, hidden, editing, running, onLaunch, onToggle }: TileProps) {
  const isUrl = tile.action.type === 'url';

  return (
    <button
      type="button"
      onClick={() => {
        if (editing && onToggle) {
          onToggle(tile.id);
        } else if (!hidden) {
          onLaunch(tile);
        }
      }}
      className={`group flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-all ${
        hidden
          ? 'border-edge/50 bg-surface-1/30 text-fg-subtle'
          : running
            ? 'border-success/60 bg-surface-1 text-fg-muted hover:border-success hover:bg-surface-2 hover:text-fg'
            : 'border-edge bg-surface-1 text-fg-muted hover:border-edge hover:bg-surface-2 hover:text-fg'
      }`}
      title={
        editing
          ? hidden
            ? `Show ${tile.label}`
            : `Hide ${tile.label}`
          : isUrl
            ? (tile.action as { type: 'url'; url: string }).url
            : running
              ? `${tile.label} (running)`
              : tile.label
      }
    >
      <span className="relative">
        <span
          className={
            hidden ? 'opacity-40' : 'text-fg-muted group-hover:text-warning transition-colors'
          }
        >
          <TileIcon tileId={tile.id} />
        </span>
        {running && !editing && (
          <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-success" />
        )}
      </span>
      <span className="truncate font-medium">{tile.label}</span>
      {editing && (
        <span className="ml-auto shrink-0">
          {hidden ? (
            <svg
              className="size-4 text-fg-subtle"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden="true"
            >
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
              <line x1="1" x2="23" y1="1" y2="23" />
            </svg>
          ) : (
            <svg
              className="size-4 text-fg-subtle"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden="true"
            >
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </span>
      )}
    </button>
  );
}
