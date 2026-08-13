import { IconEye, IconEyeOff } from '@revealui/presentation';
import type { TileDefinition } from '../../lib/tiles';
import Button from '../adapters/Button';
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
    <Button
      type="button"
      variant="ghost"
      onClick={() => {
        if (editing && onToggle) {
          onToggle(tile.id);
        } else if (!hidden) {
          onLaunch(tile);
        }
      }}
      className={`group flex h-auto items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-all ${
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
            <IconEyeOff size="sm" className="text-fg-subtle" />
          ) : (
            <IconEye size="sm" className="text-fg-subtle" />
          )}
        </span>
      )}
    </Button>
  );
}
