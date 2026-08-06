import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Button from '../../components/adapters/Button';

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('handles click events', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);

    fireEvent.click(screen.getByText('Click'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is disabled when disabled prop is true', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('is disabled when loading is true', () => {
    render(<Button loading>Loading</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('shows spinner when loading', () => {
    render(<Button loading>Submit</Button>);
    const button = screen.getByRole('button');
    const svg = button.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.classList.contains('animate-spin')).toBe(true);
  });

  it('does not show spinner when not loading', () => {
    render(<Button>Submit</Button>);
    const button = screen.getByRole('button');
    const svg = button.querySelector('svg.animate-spin');
    expect(svg).toBeNull();
  });

  it('maps primary → brand solid (bg-primary)', () => {
    render(<Button variant="primary">Primary</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('bg-primary');
  });

  it('maps secondary → neutral solid (bg-secondary) by default', () => {
    render(<Button>Default</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('bg-secondary');
  });

  it('maps ghost → neutral ghost appearance', () => {
    render(<Button variant="ghost">Ghost</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('hover:text-accent-foreground');
  });

  it('maps danger → danger solid (bg-destructive)', () => {
    render(<Button variant="danger">Delete</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('bg-destructive');
  });

  it('maps success → success solid token fill', () => {
    render(<Button variant="success">Save</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('bg-[var(--rvui-success-strong)]');
  });

  it('applies a compact size override for size="sm" (h-8, denser than presentation sm)', () => {
    render(<Button size="sm">Small</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('h-8');
  });

  it('applies presentation sm (h-10) for size="md" (the default)', () => {
    render(<Button>Default size</Button>);
    expect(screen.getByRole('button').className).toContain('h-10');
  });

  it('applies presentation default (h-11) for size="lg"', () => {
    render(<Button size="lg">Large</Button>);
    const button = screen.getByRole('button');
    expect(button.className).toContain('h-11');
  });

  it('has type="button" by default', () => {
    render(<Button>Test</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });
});
