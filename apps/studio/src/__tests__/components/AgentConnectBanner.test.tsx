import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AgentConnectBanner from '../../components/agent/AgentConnectBanner';

describe('AgentConnectBanner', () => {
  it('shows the real message and Connect Agent', () => {
    const onConnect = vi.fn();
    render(
      <AgentConnectBanner
        message="Studio lost the WSL agent relay. Connect Agent to open it again."
        connecting={false}
        onConnect={onConnect}
      />,
    );
    expect(
      screen.getByText('Studio lost the WSL agent relay. Connect Agent to open it again.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Agent' }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('disables Connect Agent while connecting', () => {
    render(
      <AgentConnectBanner
        message="Studio lost the WSL agent relay. Connect Agent to open it again."
        connecting={true}
        onConnect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Connect Agent' })).toBeDisabled();
  });
});
