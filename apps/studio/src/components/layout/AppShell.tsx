import { type ReactNode, useState } from 'react';
import { StatusContext, useStatus } from '../../hooks/use-status';
import type { Page } from '../../types';
import DegradedBanner from './DegradedBanner';
import Sidebar from './Sidebar';
import StatusBar from './StatusBar';

interface AppShellProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  children: ReactNode;
  /** Removes padding and switches to overflow-hidden for full-bleed panels */
  padless?: boolean;
}

export default function AppShell({ currentPage, onNavigate, children, padless }: AppShellProps) {
  const status = useStatus();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function handleNavigate(page: Page): void {
    onNavigate(page);
    setSidebarOpen(false);
  }

  return (
    <StatusContext.Provider value={status}>
      <div className="flex h-screen w-full overflow-hidden">
        {/* Desktop sidebar: always visible, in normal flex flow */}
        <div className="hidden shrink-0 md:block">
          <Sidebar currentPage={currentPage} onNavigate={handleNavigate} />
        </div>

        {/* Mobile sidebar: overlay + slide-in, only rendered when open */}
        {sidebarOpen && (
          <>
            <button
              type="button"
              className="fixed inset-0 z-30 bg-black/50 md:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close sidebar"
            />
            <div className="fixed inset-y-0 left-0 z-40 md:hidden">
              <Sidebar currentPage={currentPage} onNavigate={handleNavigate} />
            </div>
          </>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Persistent banner whenever the app is showing mock/degraded data */}
          <DegradedBanner />

          {/* Mobile top bar with hamburger */}
          <div className="flex items-center gap-3 border-b border-edge bg-surface-1 px-3 py-2 md:hidden">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
              aria-label="Open menu"
            >
              <svg
                className="size-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <span className="text-sm font-semibold text-fg">RevealUI Studio</span>
          </div>

          <main className={`flex-1 ${padless ? 'overflow-hidden' : 'overflow-y-auto p-3 md:p-6'}`}>
            {children}
          </main>
          <StatusBar />
        </div>
      </div>
    </StatusContext.Provider>
  );
}
