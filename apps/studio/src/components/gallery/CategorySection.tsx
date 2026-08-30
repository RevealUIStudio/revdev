import { IconChevronRight } from '@revealui/presentation';
import type { CategoryWithTiles } from '../../hooks/use-tiles';
import type { TileDefinition } from '../../lib/tiles';
import Button from '../adapters/Button';
import Tile from './Tile';

interface CategorySectionProps {
  data: CategoryWithTiles;
  editing: boolean;
  runningTileIds: Set<string>;
  onToggleCollapse: () => void;
  onLaunch: (tile: TileDefinition) => void;
  onToggleTile: (tileId: string) => void;
}

export default function CategorySection({
  data,
  editing,
  runningTileIds,
  onToggleCollapse,
  onLaunch,
  onToggleTile,
}: CategorySectionProps) {
  const { category, tiles, hiddenTiles, collapsed } = data;
  const tileCount = tiles.length + (editing ? hiddenTiles.length : 0);

  return (
    <section>
      <Button
        type="button"
        variant="ghost"
        onClick={onToggleCollapse}
        className="flex h-auto w-full items-center gap-2 py-2 text-left"
      >
        <IconChevronRight
          size="sm"
          className={`size-3.5 shrink-0 text-fg-subtle transition-transform ${collapsed ? '' : 'rotate-90'}`}
        />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
          {category.label}
        </h2>
        <span className="text-xs text-fg-subtle">{tileCount}</span>
      </Button>

      {!collapsed && (
        <div className="grid grid-cols-2 gap-2 pb-4 sm:grid-cols-3 lg:grid-cols-4">
          {tiles.map((tile) => (
            <Tile
              key={tile.id}
              tile={tile}
              editing={editing}
              running={runningTileIds.has(tile.id)}
              onLaunch={onLaunch}
              onToggle={onToggleTile}
            />
          ))}
          {editing &&
            hiddenTiles.map((tile) => (
              <Tile
                key={tile.id}
                tile={tile}
                hidden
                editing
                onLaunch={onLaunch}
                onToggle={onToggleTile}
              />
            ))}
        </div>
      )}
    </section>
  );
}
