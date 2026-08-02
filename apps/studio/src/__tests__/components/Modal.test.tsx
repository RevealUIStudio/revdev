import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Modal from '../../components/adapters/Modal';

describe('Modal', () => {
  const defaultProps = {
    title: 'Test Modal',
    open: true,
    onClose: vi.fn(),
    children: <p>Modal content</p>,
  };

  it('renders when open is true', () => {
    render(<Modal {...defaultProps} />);
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
    expect(screen.getByText('Modal content')).toBeInTheDocument();
  });

  it('does not render when open is false', () => {
    render(<Modal {...defaultProps} open={false} />);
    expect(screen.queryByText('Test Modal')).not.toBeInTheDocument();
    expect(screen.queryByText('Modal content')).not.toBeInTheDocument();
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<Modal {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close dialog'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders footer when provided', () => {
    render(
      <Modal {...defaultProps} footer={<button type="button">Save</button>}>
        Content
      </Modal>,
    );
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('does not render footer content when not provided', () => {
    render(<Modal {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('renders with sm maxWidth', () => {
    render(<Modal {...defaultProps} maxWidth="sm" />);
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
  });

  it('renders with md maxWidth by default', () => {
    render(<Modal {...defaultProps} />);
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
  });

  it('renders with lg maxWidth', () => {
    render(<Modal {...defaultProps} maxWidth="lg" />);
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
  });
});
