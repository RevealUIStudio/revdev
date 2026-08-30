import {
  IconCode,
  IconLock,
  IconRefresh,
  IconSettings,
  IconTerminal,
  IconUsers,
  RevealUIMark,
} from '@revealui/presentation';
import { useMemo, useState } from 'react';
import type { Page } from '../../types';
import Button from '../adapters/Button';

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

type NavItem = { page: Page; label: string; icon: string };
type NavGroupId = 'operate' | 'build' | 'configure';

interface NavGroup {
  id: NavGroupId;
  label: string;
  items: NavItem[];
}

/**
 * Frontend-excellence Phase 2 hard rule: destinations → 3 progressive-
 * disclosure groups (Operate / Build / Configure). Group containing the
 * current page starts open; others start collapsed.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    id: 'operate',
    label: 'Operate',
    items: [
      { page: 'dashboard', label: 'Dashboard', icon: 'grid' },
      { page: 'fleet', label: 'Fleet map', icon: 'map' },
      { page: 'gallery', label: 'Launcher', icon: 'rocket' },
      { page: 'agent', label: 'Agent', icon: 'agent' },
      { page: 'terminal', label: 'Terminal', icon: 'terminal' },
      { page: 'vault', label: 'Vault', icon: 'lock' },
    ],
  },
  {
    id: 'build',
    label: 'Build',
    items: [
      { page: 'editor', label: 'Editor', icon: 'editor' },
      { page: 'git', label: 'Git', icon: 'git' },
      { page: 'inference', label: 'Inference', icon: 'inference' },
      { page: 'sync', label: 'Sync', icon: 'refresh' },
    ],
  },
  {
    id: 'configure',
    label: 'Configure',
    items: [
      { page: 'infrastructure', label: 'Infrastructure', icon: 'server' },
      { page: 'setup', label: 'Setup', icon: 'settings' },
      { page: 'settings', label: 'Settings', icon: 'wrench' },
    ],
  },
];

function groupForPage(page: Page): NavGroupId {
  for (const group of NAV_GROUPS) {
    if (group.items.some((item) => item.page === page)) {
      return group.id;
    }
  }
  // deploy and any future pages: default into Operate so the nav is never empty
  return 'operate';
}

export default function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const activeGroup = useMemo(() => groupForPage(currentPage), [currentPage]);
  const [openGroups, setOpenGroups] = useState<Record<NavGroupId, boolean>>(() => ({
    operate: activeGroup === 'operate',
    build: activeGroup === 'build',
    configure: activeGroup === 'configure',
  }));

  // Keep the group that owns the current page open when navigation lands
  // from outside the sidebar (e.g. deep-link / intent screen).
  const effectiveOpen: Record<NavGroupId, boolean> = {
    operate: openGroups.operate || activeGroup === 'operate',
    build: openGroups.build || activeGroup === 'build',
    configure: openGroups.configure || activeGroup === 'configure',
  };

  function toggleGroup(id: NavGroupId) {
    setOpenGroups((prev) => ({
      ...prev,
      // Do not collapse the group that owns the current page — user would
      // lose the highlighted item without a way to see where they are.
      [id]: activeGroup === id ? true : !prev[id],
    }));
  }

  return (
    <aside className="flex h-full w-56 flex-col border-r border-edge bg-surface-1">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-4">
        <RevealUIMark className="size-8 shrink-0 text-fg" title="RevealUI" />
        <span className="text-sm font-semibold">RevealUI Studio</span>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3" aria-label="Studio">
        {NAV_GROUPS.map((group) => {
          const isOpen = effectiveOpen[group.id];
          return (
            <div key={group.id} className="pb-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => toggleGroup(group.id)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase hover:bg-surface-3 hover:text-fg"
              >
                <span>{group.label}</span>
                <span aria-hidden="true" className="text-[10px]">
                  {isOpen ? '▾' : '▸'}
                </span>
              </Button>
              {isOpen && (
                <div className="mt-0.5 space-y-0.5">
                  {group.items.map((item) => (
                    <Button
                      key={item.page}
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onNavigate(item.page)}
                      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                        currentPage === item.page
                          ? 'bg-surface-3 text-fg'
                          : 'text-fg-muted hover:bg-surface-3 hover:text-fg'
                      }`}
                    >
                      <NavIcon name={item.icon} />
                      {item.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

function NavIcon({ name }: { name: string }) {
  switch (name) {
    case 'grid':
      return (
        <svg
          className="size-4"
          aria-hidden="true"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M4 5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5ZM14 5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V5ZM4 15a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4ZM14 15a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4Z" />
        </svg>
      );
    case 'lock':
      return <IconLock size="sm" />;
    case 'server':
      return (
        <svg
          className="size-4"
          aria-hidden="true"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
          <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
          <line x1="6" x2="6" y1="6" y2="6" />
          <line x1="6" x2="6" y1="18" y2="18" />
        </svg>
      );
    case 'refresh':
      return <IconRefresh size="sm" />;
    case 'terminal':
      return <IconTerminal size="sm" />;
    case 'settings':
      return <IconSettings size="sm" />;
    case 'git':
      return (
        <svg
          className="size-4"
          aria-hidden="true"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="18" r="3" />
          <line x1="6" y1="3" x2="6" y2="15" />
          <path d="M18 9v3a6 6 0 0 1-6 6H9" />
        </svg>
      );
    case 'editor':
      return <IconCode size="sm" />;
    case 'agent':
      return <IconUsers size="sm" />;
    case 'inference':
      return (
        <svg
          className="size-4"
          aria-hidden="true"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4Z" />
          <circle cx="12" cy="15" r="2" />
          <path d="M12 13v-2" />
        </svg>
      );
    case 'rocket':
      return (
        <svg
          className="size-4"
          aria-hidden="true"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09Z" />
          <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z" />
          <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
          <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
      );
    case 'wrench':
      return <IconSettings size="sm" />;
    case 'map':
      return (
        <svg
          className="size-4"
          aria-hidden="true"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" />
          <line x1="9" x2="9" y1="3" y2="18" />
          <line x1="15" x2="15" y1="6" y2="21" />
        </svg>
      );
    default:
      return <span className="size-4" />;
  }
}
