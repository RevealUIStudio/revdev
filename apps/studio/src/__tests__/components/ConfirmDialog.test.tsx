import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ConfirmDialog from '../../components/ui/ConfirmDialog';

describe('ConfirmDialog', () => {
  it('renders the title and body when open', () => {
    render(
      <ConfirmDialog
        open
        title="Delete secret"
        body="This cannot be undone."
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Delete secret')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });

  it('enables confirm immediately when no type-to-confirm is required', () => {
    render(
      <ConfirmDialog
        open
        title="Stop daemon"
        body="Sessions end."
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Delete').closest('button')).not.toBeDisabled();
  });

  it('keeps confirm disabled until the exact phrase is typed', () => {
    render(
      <ConfirmDialog
        open
        title="Delete secret"
        body="Irreversible."
        typeToConfirm="stripe/api_key"
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const confirm = screen.getByText('Delete').closest('button');
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wrong' } });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'stripe/api_key' } });
    expect(confirm).not.toBeDisabled();
  });

  it('calls onConfirm only after the phrase matches', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Discard all"
        body="Throws away edits."
        typeToConfirm="discard"
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Delete'));
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'discard' } });
    fireEvent.click(screen.getByText('Delete'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<ConfirmDialog open title="Delete" body="x" onConfirm={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('lists affected items when provided', () => {
    render(
      <ConfirmDialog
        open
        title="Discard all"
        body="These files:"
        affectedItems={['src/a.ts', 'src/b.ts']}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
  });
});
