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
    expect(badge.className).toContain('bg-muted');
    expect(badge.className).toContain('text-muted-foreground');
  });

  it('applies success variant styles', () => {
    render(<Badge variant="success">OK</Badge>);
    const badge = screen.getByText('OK');
    expect(badge.className).toContain('text-success');
  });

  it('applies warning variant styles', () => {
    render(<Badge variant="warning">Warn</Badge>);
    const badge = screen.getByText('Warn');
    expect(badge.className).toContain('text-warning-foreground');
  });

  it('applies error variant styles', () => {
    render(<Badge variant="error">Fail</Badge>);
    const badge = screen.getByText('Fail');
    expect(badge.className).toContain('text-destructive');
  });

  it('applies info variant styles', () => {
    render(<Badge variant="info">Info</Badge>);
    const badge = screen.getByText('Info');
    expect(badge.className).toContain('text-sky-700');
  });

  it('applies brand variant styles', () => {
    render(<Badge variant="brand">Pro</Badge>);
    const badge = screen.getByText('Pro');
    expect(badge.className).toContain('text-primary');
  });

  it('accepts size="sm" without erroring (presentation Badge has no size axis; accepted no-op)', () => {
    render(<Badge size="sm">Small</Badge>);
    expect(screen.getByText('Small')).toBeInTheDocument();
  });

  it('renders at presentation Badge default sizing regardless of size prop', () => {
    render(<Badge>Medium</Badge>);
    const badge = screen.getByText('Medium');
    expect(badge.className).toContain('text-sm/5');
  });

  it('applies custom className', () => {
    render(<Badge className="ml-2">Custom</Badge>);
    const badge = screen.getByText('Custom');
    expect(badge.className).toContain('ml-2');
  });
});
