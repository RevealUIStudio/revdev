import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/use-sync', () => ({
  useSync: vi.fn().mockReturnValue({
    syncingRepos: new Set<string>(),
    anySyncing: false,
    results: [],
    log: [],
    globalError: null,
    errors: {},
    syncAll: vi.fn(),
    syncOne: vi.fn(),
  }),
}));

import SyncPanel from '../../components/sync/SyncPanel';
import { useSync } from '../../hooks/use-sync';

describe('SyncPanel', () => {
  it('renders "Repo Sync" heading', () => {
    render(<SyncPanel />);
    expect(screen.getByText('Repo Sync')).toBeInTheDocument();
  });

  it('renders "Sync All" button', () => {
    render(<SyncPanel />);
    expect(screen.getByText('Sync All')).toBeInTheDocument();
  });

  it('shows empty state message when no results and not syncing', () => {
    render(<SyncPanel />);
    expect(
      screen.getByText(/Click "Sync All" to fetch and sync all registered repos/),
    ).toBeInTheDocument();
  });

  it('shows repo cards when results exist', () => {
    vi.mocked(useSync).mockReturnValue({
      syncingRepos: new Set<string>(),
      anySyncing: false,
      results: [
        { drive: 'C', repo: 'RevealUI', status: 'ok', branch: 'main' },
        { drive: 'E', repo: 'my-private-repo', status: 'dirty', branch: 'main' },
      ],
      log: [],
      globalError: null,
      errors: {},
      syncAll: vi.fn(),
      syncOne: vi.fn(),
    });
    render(<SyncPanel />);
    expect(screen.getByText('RevealUI')).toBeInTheDocument();
    expect(screen.getByText('my-private-repo')).toBeInTheDocument();
  });

  it('shows sync log when entries exist', () => {
    vi.mocked(useSync).mockReturnValue({
      syncingRepos: new Set<string>(),
      anySyncing: false,
      results: [],
      log: ['Syncing...', 'Done'],
      globalError: null,
      errors: {},
      syncAll: vi.fn(),
      syncOne: vi.fn(),
    });
    render(<SyncPanel />);
    expect(screen.getByText('Sync Log')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('shows a global error when the Sync All path fails', () => {
    vi.mocked(useSync).mockReturnValue({
      syncingRepos: new Set<string>(),
      anySyncing: false,
      results: [],
      log: [],
      globalError: 'Sync failed',
      errors: {},
      syncAll: vi.fn(),
      syncOne: vi.fn(),
    });
    render(<SyncPanel />);
    expect(screen.getByText('Sync failed')).toBeInTheDocument();
  });

  it('shows a per-repo error under only the affected card', () => {
    vi.mocked(useSync).mockReturnValue({
      syncingRepos: new Set<string>(),
      anySyncing: false,
      results: [
        { drive: 'C', repo: 'RevealUI', status: 'error', branch: 'main' },
        { drive: 'E', repo: 'my-private-repo', status: 'ok', branch: 'main' },
      ],
      log: [],
      globalError: null,
      errors: { 'C/RevealUI': 'Dirty working tree' },
      syncAll: vi.fn(),
      syncOne: vi.fn(),
    });
    render(<SyncPanel />);
    // The error appears exactly once — only the keyed card renders it.
    expect(screen.getAllByText('Dirty working tree')).toHaveLength(1);
  });

  it('isolates syncing state between same-named repos on different drives', () => {
    vi.mocked(useSync).mockReturnValue({
      syncingRepos: new Set<string>(['C/shared']),
      anySyncing: true,
      results: [
        { drive: 'C', repo: 'shared', status: 'ok', branch: 'main' },
        { drive: 'E', repo: 'shared', status: 'ok', branch: 'main' },
      ],
      log: [],
      globalError: null,
      errors: {},
      syncAll: vi.fn(),
      syncOne: vi.fn(),
    });
    render(<SyncPanel />);
    // Both cards render the same repo name…
    expect(screen.getAllByText('shared')).toHaveLength(2);
    // …but only the C/shared card's Sync button is disabled (syncing); E/shared stays actionable.
    const syncButtons = screen.getAllByText('Sync').map((el) => el.closest('button'));
    expect(syncButtons[0]).toBeDisabled();
    expect(syncButtons[1]).not.toBeDisabled();
  });
});
