import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Badge from '../../components/ui/Badge';

describe('Badge', () => {
  it('renders children', () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('applies default variant styles', () => {
    render(<Badge>Default</Badge>);
    const badge = screen.getByText('Default');
    expect(badge.className).toContain('bg-zinc-600/10');
    expect(badge.className).toContain('text-zinc-700');
  });

  it('applies success variant styles', () => {
    render(<Badge variant="success">OK</Badge>);
    const badge = screen.getByText('OK');
    expect(badge.className).toContain('text-green-700');
  });

  it('applies warning variant styles', () => {
    render(<Badge variant="warning">Warn</Badge>);
    const badge = screen.getByText('Warn');
    expect(badge.className).toContain('text-yellow-700');
  });

  it('applies error variant styles', () => {
    render(<Badge variant="error">Fail</Badge>);
    const badge = screen.getByText('Fail');
    expect(badge.className).toContain('text-red-700');
  });

  it('applies info variant styles', () => {
    render(<Badge variant="info">Info</Badge>);
    const badge = screen.getByText('Info');
    expect(badge.className).toContain('text-blue-700');
  });

  it('applies brand variant styles', () => {
    render(<Badge variant="brand">Pro</Badge>);
    const badge = screen.getByText('Pro');
    expect(badge.className).toContain('text-emerald-700');
  });

  it('applies sm size styles', () => {
    render(<Badge size="sm">Small</Badge>);
    const badge = screen.getByText('Small');
    expect(badge.className).toContain('px-1.5');
  });

  it('applies md size styles by default', () => {
    render(<Badge>Medium</Badge>);
    const badge = screen.getByText('Medium');
    expect(badge.className).toContain('px-2');
  });

  it('applies custom className', () => {
    render(<Badge className="ml-2">Custom</Badge>);
    const badge = screen.getByText('Custom');
    expect(badge.className).toContain('ml-2');
  });
});
