import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Sidebar from '../../components/layout/Sidebar';

describe('Sidebar', () => {
  it('renders Operate / Build / Configure group labels', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={vi.fn()} />);

    expect(screen.getByText('Operate')).toBeInTheDocument();
    expect(screen.getByText('Build')).toBeInTheDocument();
    expect(screen.getByText('Configure')).toBeInTheDocument();
  });

  it('opens the group that owns the current page and shows its items', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={vi.fn()} />);

    // Operate is open (owns dashboard)
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Vault')).toBeInTheDocument();
    expect(screen.getByText('Terminal')).toBeInTheDocument();

    // Build / Configure start collapsed — their items are hidden
    expect(screen.queryByText('Editor')).not.toBeInTheDocument();
    expect(screen.queryByText('Infrastructure')).not.toBeInTheDocument();
    expect(screen.queryByText('Setup')).not.toBeInTheDocument();
  });

  it('expands Build when its header is clicked', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByText('Build'));

    expect(screen.getByText('Editor')).toBeInTheDocument();
    expect(screen.getByText('Git')).toBeInTheDocument();
    expect(screen.getByText('Inference')).toBeInTheDocument();
    expect(screen.getByText('Sync')).toBeInTheDocument();
  });

  it('expands Configure when its header is clicked', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByText('Configure'));

    expect(screen.getByText('Infrastructure')).toBeInTheDocument();
    expect(screen.getByText('Setup')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('opens Configure when the current page is Setup', () => {
    render(<Sidebar currentPage="setup" onNavigate={vi.fn()} />);

    expect(screen.getByText('Setup')).toBeInTheDocument();
    expect(screen.getByText('Infrastructure')).toBeInTheDocument();
    // Operate items not required to be visible
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('renders the brand name', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={vi.fn()} />);

    expect(screen.getByText('RevealUI Studio')).toBeInTheDocument();
  });

  it('calls onNavigate when a nav item is clicked', () => {
    const onNavigate = vi.fn();
    render(<Sidebar currentPage="dashboard" onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText('Vault'));

    expect(onNavigate).toHaveBeenCalledWith('vault');
  });

  it('highlights the current page', () => {
    render(<Sidebar currentPage="vault" onNavigate={vi.fn()} />);

    const vaultButton = screen.getByText('Vault').closest('button');
    const vaultClasses = vaultButton?.className.split(' ') ?? [];
    expect(vaultClasses).toContain('bg-surface-3');
    expect(vaultClasses).toContain('text-fg');
  });

  it('does not highlight non-current pages', () => {
    render(<Sidebar currentPage="vault" onNavigate={vi.fn()} />);

    const dashboardButton = screen.getByText('Dashboard').closest('button');
    const dashboardClasses = dashboardButton?.className.split(' ') ?? [];
    expect(dashboardClasses).toContain('text-fg-muted');
    expect(dashboardClasses).not.toContain('bg-surface-3');
  });

  it('navigates to each page within the open Operate group', () => {
    const onNavigate = vi.fn();
    render(<Sidebar currentPage="dashboard" onNavigate={onNavigate} />);

    const pages = ['Dashboard', 'Vault', 'Terminal'];
    const pageIds = ['dashboard', 'vault', 'terminal'];

    for (let i = 0; i < pages.length; i++) {
      fireEvent.click(screen.getByText(pages[i]));
      expect(onNavigate).toHaveBeenCalledWith(pageIds[i]);
    }
  });

  it('renders the RevealUI mark, not a letter tile', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={vi.fn()} />);

    expect(screen.getByRole('img', { name: 'RevealUI' })).toBeInTheDocument();
    expect(screen.queryByText('R')).not.toBeInTheDocument();
  });
});
