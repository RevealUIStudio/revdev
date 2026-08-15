import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import IntentScreen from '../../components/intent/IntentScreen';

/** Click the <button> ancestor of a heading, failing loudly if absent. */
function clickHeadingButton(name: string): void {
  const button = screen.getByRole('heading', { name }).closest('button');
  if (!button) throw new Error(`No <button> ancestor for heading "${name}"`);
  fireEvent.click(button);
}

describe('IntentScreen', () => {
  it('renders the RevealUI mark', () => {
    render(<IntentScreen onSelect={vi.fn()} />);

    expect(screen.getByRole('img', { name: 'RevealUI' })).toBeInTheDocument();
  });

  it('renders a path question and next-step copy', () => {
    render(<IntentScreen onSelect={vi.fn()} />);

    expect(screen.getByText('How will you use Studio?')).toBeInTheDocument();
    expect(screen.getByText(/Pick a path. One click opens that workspace/)).toBeInTheDocument();
    expect(screen.getByText(/open Agent in the sidebar/)).toBeInTheDocument();
  });

  it('renders Develop and Deploy options', () => {
    render(<IntentScreen onSelect={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Deploy' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Develop' })).toBeInTheDocument();
  });

  it('calls onSelect with "develop" when the Develop card is clicked', () => {
    const onSelect = vi.fn();
    render(<IntentScreen onSelect={onSelect} />);

    clickHeadingButton('Develop');
    expect(onSelect).toHaveBeenCalledWith('develop');
  });

  it('calls onSelect with "deploy" when the Deploy card is clicked', () => {
    const onSelect = vi.fn();
    render(<IntentScreen onSelect={onSelect} />);

    clickHeadingButton('Deploy');
    expect(onSelect).toHaveBeenCalledWith('deploy');
  });

  it('does not leave a disabled Continue trap', () => {
    render(<IntentScreen onSelect={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
  });
});
