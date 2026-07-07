import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SecretList from '../../components/vault/SecretList';
import type { SecretInfo } from '../../types';

const SECRETS: SecretInfo[] = [
  { path: 'stripe/secret_key', namespace: 'stripe' },
  { path: 'neon/database_url', namespace: 'neon' },
  { path: 'vercel/api_token', namespace: 'vercel' },
];

describe('SecretList', () => {
  it('shows "No secrets found" when list is empty', () => {
    render(<SecretList secrets={[]} selectedPath={null} onSelect={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('No secrets found')).toBeInTheDocument();
  });

  it('renders all secrets', () => {
    render(
      <SecretList secrets={SECRETS} selectedPath={null} onSelect={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(screen.getByText('secret_key')).toBeInTheDocument();
    expect(screen.getByText('database_url')).toBeInTheDocument();
    expect(screen.getByText('api_token')).toBeInTheDocument();
  });

  it('displays full path as secondary text', () => {
    render(
      <SecretList secrets={SECRETS} selectedPath={null} onSelect={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(screen.getByText('stripe/secret_key')).toBeInTheDocument();
    expect(screen.getByText('neon/database_url')).toBeInTheDocument();
  });

  it('calls onSelect when a secret is clicked', () => {
    const onSelect = vi.fn();
    render(
      <SecretList secrets={SECRETS} selectedPath={null} onSelect={onSelect} onDelete={vi.fn()} />,
    );
    // Click the button element that contains the secret text
    const buttons = screen.getAllByRole('button', { name: /secret_key|database_url|api_token/i });
    fireEvent.click(buttons[0]);
    expect(onSelect).toHaveBeenCalledWith('stripe/secret_key');
  });

  it('does not call onDelete until the confirm dialog is confirmed', () => {
    const onDelete = vi.fn();
    render(
      <SecretList secrets={SECRETS} selectedPath={null} onSelect={vi.fn()} onDelete={onDelete} />,
    );
    // Clicking the trash icon opens the confirm dialog — it must NOT delete yet.
    fireEvent.click(screen.getByLabelText('Delete stripe/secret_key'));
    expect(onDelete).not.toHaveBeenCalled();

    // Type-to-confirm uses the secret key name; confirm only fires after it matches.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'secret_key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete secret' }));
    expect(onDelete).toHaveBeenCalledWith('stripe/secret_key');
  });

  it('highlights selected secret', () => {
    const { container } = render(
      <SecretList
        secrets={SECRETS}
        selectedPath="stripe/secret_key"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const selectedRow = container.querySelector('.bg-surface-2.text-fg');
    expect(selectedRow).not.toBeNull();
  });
});
