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
  it('renders welcome heading and description', () => {
    render(<IntentScreen onSelect={vi.fn()} />);

    expect(screen.getByText('Welcome to RevealUI Studio')).toBeInTheDocument();
    expect(screen.getByText('How would you like to use RevealUI?')).toBeInTheDocument();
  });

  it('renders Deploy and Develop options', () => {
    render(<IntentScreen onSelect={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Deploy' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Develop' })).toBeInTheDocument();
  });

  it('Continue button is disabled when nothing is selected', () => {
    render(<IntentScreen onSelect={vi.fn()} />);

    expect(screen.getByText('Continue')).toBeDisabled();
  });

  it('enables Continue after selecting Deploy', () => {
    render(<IntentScreen onSelect={vi.fn()} />);

    clickHeadingButton('Deploy');
    expect(screen.getByText('Continue')).not.toBeDisabled();
  });

  it('calls onSelect with "deploy" when Deploy is selected and Continue clicked', () => {
    const onSelect = vi.fn();
    render(<IntentScreen onSelect={onSelect} />);

    clickHeadingButton('Deploy');
    fireEvent.click(screen.getByText('Continue'));
    expect(onSelect).toHaveBeenCalledWith('deploy');
  });

  it('calls onSelect with "develop" when Develop is selected and Continue clicked', () => {
    const onSelect = vi.fn();
    render(<IntentScreen onSelect={onSelect} />);

    clickHeadingButton('Develop');
    fireEvent.click(screen.getByText('Continue'));
    expect(onSelect).toHaveBeenCalledWith('develop');
  });
});
