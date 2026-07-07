import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RepoCard from '../../components/sync/RepoCard';
import type { SyncResult } from '../../types';

const OK_RESULT: SyncResult = {
  drive: 'C',
  repo: 'RevealUI',
  status: 'ok',
  branch: 'main',
};

const DIRTY_RESULT: SyncResult = {
  drive: 'E',
  repo: 'my-private-repo',
  status: 'dirty',
  branch: 'feat/test',
};

const ERROR_RESULT: SyncResult = {
  drive: 'C',
  repo: 'broken-repo',
  status: 'error',
  branch: 'main',
};

describe('RepoCard', () => {
  it('renders repo name', () => {
    render(<RepoCard result={OK_RESULT} onSync={vi.fn()} syncing={false} error={null} />);
    expect(screen.getByText('RevealUI')).toBeInTheDocument();
  });

  it('renders drive letter', () => {
    render(<RepoCard result={OK_RESULT} onSync={vi.fn()} syncing={false} error={null} />);
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('renders branch name', () => {
    render(<RepoCard result={OK_RESULT} onSync={vi.fn()} syncing={false} error={null} />);
    expect(screen.getByText('main')).toBeInTheDocument();
  });

  it('renders status in uppercase', () => {
    render(<RepoCard result={OK_RESULT} onSync={vi.fn()} syncing={false} error={null} />);
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('applies green style for ok status', () => {
    render(<RepoCard result={OK_RESULT} onSync={vi.fn()} syncing={false} error={null} />);
    const statusEl = screen.getByText('OK');
    expect(statusEl.className).toContain('text-success');
  });

  it('applies yellow style for dirty status', () => {
    render(<RepoCard result={DIRTY_RESULT} onSync={vi.fn()} syncing={false} error={null} />);
    const statusEl = screen.getByText('DIRTY');
    expect(statusEl.className).toContain('text-warning');
  });

  it('applies red style for error status', () => {
    render(<RepoCard result={ERROR_RESULT} onSync={vi.fn()} syncing={false} error={null} />);
    const statusEl = screen.getByText('ERROR');
    expect(statusEl.className).toContain('text-error');
  });

  it('renders a per-repo error message when one is set', () => {
    render(
      <RepoCard
        result={ERROR_RESULT}
        onSync={vi.fn()}
        syncing={false}
        error="Dirty working tree"
      />,
    );
    expect(screen.getByText('Dirty working tree')).toBeInTheDocument();
  });

  it('calls onSync when Sync button is clicked', () => {
    const onSync = vi.fn();
    render(<RepoCard result={OK_RESULT} onSync={onSync} syncing={false} error={null} />);
    fireEvent.click(screen.getByText('Sync'));
    expect(onSync).toHaveBeenCalledOnce();
  });

  it('disables Sync button when syncing', () => {
    render(<RepoCard result={OK_RESULT} onSync={vi.fn()} syncing={true} error={null} />);
    expect(screen.getByText('Sync').closest('button')).toBeDisabled();
  });
});
