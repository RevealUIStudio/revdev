import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Dialog from '../../components/ui/Dialog';

describe('Dialog', () => {
  it('renders nothing when closed', () => {
    render(
      <Dialog open={false} onClose={vi.fn()} title="Test">
        Body
      </Dialog>,
    );
    expect(screen.queryByText('Test')).not.toBeInTheDocument();
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
  });

  it('renders when open', () => {
    render(
      <Dialog open={true} onClose={vi.fn()} title="My Dialog">
        Dialog body
      </Dialog>,
    );
    expect(screen.getByText('My Dialog')).toBeInTheDocument();
    expect(screen.getByText('Dialog body')).toBeInTheDocument();
  });

  it('renders title and description', () => {
    render(<Dialog open={true} onClose={vi.fn()} title="Confirm" description="Are you sure?" />);
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
  });

  it('renders actions', () => {
    render(
      <Dialog
        open={true}
        onClose={vi.fn()}
        title="Actions"
        actions={<button type="button">Save</button>}
      />,
    );
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <Dialog open={true} onClose={onClose} title="Closeable">
        Content
      </Dialog>,
    );
    fireEvent.click(screen.getByLabelText('Close dialog'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not render actions content when actions not provided', () => {
    render(
      <Dialog open={true} onClose={vi.fn()} title="No Actions">
        Body
      </Dialog>,
    );
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });
});
