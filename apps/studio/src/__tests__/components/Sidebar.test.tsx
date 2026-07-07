import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Sidebar from '../../components/layout/Sidebar';

describe('Sidebar', () => {
  it('renders all navigation items', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={vi.fn()} />);

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Vault')).toBeInTheDocument();
    expect(screen.getByText('Infrastructure')).toBeInTheDocument();
    expect(screen.getByText('Sync')).toBeInTheDocument();
    expect(screen.getByText('Terminal')).toBeInTheDocument();
    expect(screen.getByText('Setup')).toBeInTheDocument();
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
    expect(dashboardClasses).not.toContain('text-fg');
  });

  it('navigates to each page', () => {
    const onNavigate = vi.fn();
    render(<Sidebar currentPage="dashboard" onNavigate={onNavigate} />);

    const pages = ['Dashboard', 'Vault', 'Infrastructure', 'Sync', 'Terminal', 'Setup'];
    const pageIds = ['dashboard', 'vault', 'infrastructure', 'sync', 'terminal', 'setup'];

    for (let i = 0; i < pages.length; i++) {
      fireEvent.click(screen.getByText(pages[i]));
      expect(onNavigate).toHaveBeenCalledWith(pageIds[i]);
    }
  });

  it('renders the R brand icon', () => {
    render(<Sidebar currentPage="dashboard" onNavigate={vi.fn()} />);

    expect(screen.getByText('R')).toBeInTheDocument();
  });
});
