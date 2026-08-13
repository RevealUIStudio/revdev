import { IconClose, IconSearch } from '@revealui/presentation';
import { useTiles } from '../../hooks/use-tiles';
import Button from '../adapters/Button';
import Input from '../adapters/Input';
import PanelHeader from '../adapters/PanelHeader';
import CategorySection from './CategorySection';
import Tile from './Tile';

export default function TileGallery() {
  const {
    categories,
    recentTiles,
    runningTileIds,
    query,
    setQuery,
    editing,
    toggleEditing,
    toggleTile,
    toggleCategory,
    launch,
  } = useTiles();

  return (
    <div className="space-y-4">
      <PanelHeader
        title="Launcher"
        action={
          <Button variant={editing ? 'primary' : 'ghost'} size="sm" onClick={toggleEditing}>
            {editing ? 'Done' : 'Edit'}
          </Button>
        }
      />

      {/* Search bar */}
      <div className="relative">
        <IconSearch
          size="sm"
          className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-fg-subtle"
        />
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tiles..."
          className="pl-10 pr-9"
        />
        {query && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 z-10 h-auto -translate-y-1/2 p-1 text-fg-subtle hover:text-fg-muted"
            aria-label="Clear search"
          >
            <IconClose size="sm" />
          </Button>
        )}
      </div>

      {/* Recent launches */}
      {recentTiles.length > 0 && !query && !editing && (
        <section>
          <h2 className="py-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            Recent
          </h2>
          <div className="grid grid-cols-2 gap-2 pb-2 sm:grid-cols-3 lg:grid-cols-4">
            {recentTiles.map((tile) => (
              <Tile
                key={tile.id}
                tile={tile}
                running={runningTileIds.has(tile.id)}
                onLaunch={launch}
              />
            ))}
          </div>
        </section>
      )}

      {/* Category sections */}
      {categories.length > 0 ? (
        <div className="space-y-1">
          {categories.map((cat) => (
            <CategorySection
              key={cat.category.id}
              data={cat}
              editing={editing}
              runningTileIds={runningTileIds}
              onToggleCollapse={() => toggleCategory(cat.category.id)}
              onLaunch={launch}
              onToggleTile={toggleTile}
            />
          ))}
        </div>
      ) : (
        <div className="py-12 text-center text-sm text-fg-subtle">
          {query ? `No tiles matching "${query}"` : 'No tiles configured'}
        </div>
      )}

      {editing && (
        <p className="text-xs text-fg-subtle">
          Click the eye icon to show or hide tiles. Changes are saved automatically.
        </p>
      )}
    </div>
  );
}
