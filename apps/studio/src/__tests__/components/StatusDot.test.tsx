import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StatusDot from '../../components/ui/StatusDot';

describe('StatusDot', () => {
  it('renders a span element', () => {
    const { container } = render(<StatusDot status="ok" />);
    expect(container.querySelector('span')).not.toBeNull();
  });

  it('applies --rvui-success token for ok status', () => {
    const { container } = render(<StatusDot status="ok" />);
    expect(container.innerHTML).toContain('bg-[var(--rvui-success)]');
  });

  it('applies --rvui-warning token for warn status', () => {
    const { container } = render(<StatusDot status="warn" />);
    expect(container.innerHTML).toContain('bg-[var(--rvui-warning)]');
  });

  it('applies --rvui-error token for error status', () => {
    const { container } = render(<StatusDot status="error" />);
    expect(container.innerHTML).toContain('bg-[var(--rvui-error)]');
  });

  it('maps off → presentation idle fill (--rvui-text-2)', () => {
    const { container } = render(<StatusDot status="off" />);
    expect(container.innerHTML).toContain('bg-[var(--rvui-text-2)]');
  });

  it('exposes status to assistive tech via role="img" + aria-label by default', () => {
    const { container } = render(<StatusDot status="error" />);
    const span = container.querySelector('span[role="img"]');
    expect(span).not.toBeNull();
    expect(span?.getAttribute('aria-label')).toBe('Error');
  });

  it('uses a per-status default label', () => {
    const { container } = render(<StatusDot status="warn" />);
    const span = container.querySelector('span[role="img"]');
    expect(span?.getAttribute('aria-label')).toBe('Warning');
  });

  it('honors a custom label override', () => {
    const { container } = render(<StatusDot status="ok" label="Database: healthy" />);
    const span = container.querySelector('span[role="img"]');
    expect(span?.getAttribute('aria-label')).toBe('Database: healthy');
  });

  it('is hidden from screen readers when decorative (adjacent text conveys status)', () => {
    const { container } = render(<StatusDot status="ok" decorative />);
    const span = container.querySelector('span');
    expect(span?.getAttribute('aria-hidden')).toBe('true');
    expect(span?.getAttribute('role')).toBeNull();
    expect(span?.getAttribute('aria-label')).toBeNull();
  });

  it('applies custom className', () => {
    const { container } = render(<StatusDot status="ok" className="ml-2" />);
    expect(container.innerHTML).toContain('ml-2');
  });

  it('emits a pulse ring when pulse is true (presentation animate-ping)', () => {
    const { container } = render(<StatusDot status="ok" pulse />);
    expect(container.innerHTML).toContain('animate-ping');
  });
});
