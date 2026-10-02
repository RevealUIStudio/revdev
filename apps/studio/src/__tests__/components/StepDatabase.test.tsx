import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StepDatabase from '../../components/deploy/StepDatabase';
import { neonTestConnection, runDbMigrate, runDbSeed } from '../../lib/deploy';
import type { StudioConfig, WizardData } from '../../types';

vi.mock('../../lib/deploy', () => ({
  neonTestConnection: vi.fn().mockResolvedValue('ok'),
  runDbMigrate: vi.fn().mockResolvedValue('done'),
  runDbSeed: vi.fn().mockResolvedValue('done'),
}));

const MOCK_CONFIG: StudioConfig = {
  intent: 'deploy',
  setupComplete: true,
  completedSteps: [],
  deploy: null,
  develop: { repoPath: '/workspace/revealui', wslDistro: null, nixInstalled: false },
};

const MOCK_DATA: WizardData = {
  vercelToken: '',
  vercelProjects: { api: '', admin: '', marketing: '' },
  postgresUrl: '',
  stripeSecretKey: '',
  stripePublishableKey: '',
  stripeWebhookSecret: '',
  stripePriceIds: { pro: '', max: '', enterprise: '' },
  licensePrivateKey: '',
  licensePublicKey: '',
  emailProvider: 'gmail',
  blobToken: '',
  revealuiSecret: '',
  revealuiKek: '',
  cronSecret: '',
  domain: '',
  signupOpen: true,
};

describe('StepDatabase', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires an explicit project directory before testing a database', () => {
    render(
      <StepDatabase
        config={{ ...MOCK_CONFIG, develop: null }}
        data={{ ...MOCK_DATA, postgresUrl: 'postgresql://selected.invalid/db' }}
        onUpdateData={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Connect & Migrate' })).toBeDisabled();
  });

  it('migrates and seeds only the selected target after its confirmations', async () => {
    const postgresUrl = 'postgresql://audit:private-password@selected.invalid/chosen';
    const update = vi.fn();
    render(
      <StepDatabase
        config={MOCK_CONFIG}
        data={{ ...MOCK_DATA, postgresUrl }}
        onUpdateData={update}
        onNext={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect & Migrate' }));
    expect(
      await screen.findByRole('dialog', { name: 'Run schema migration?' }),
    ).toBeInTheDocument();
    expect(neonTestConnection).toHaveBeenCalledWith(postgresUrl);
    expect(screen.getByText('Database: selected.invalid/chosen')).toBeInTheDocument();
    expect(screen.queryByText(/private-password/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/PostgreSQL Connection String/)).toBeDisabled();
    expect(runDbMigrate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run migration' }));
    expect(await screen.findByRole('dialog', { name: 'Seed database?' })).toBeInTheDocument();
    expect(runDbMigrate).toHaveBeenCalledWith('/workspace/revealui', postgresUrl);
    expect(runDbSeed).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: /Type seed to confirm/ }), {
      target: { value: 'seed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Seed database' }));
    expect(await screen.findByText('Database ready')).toBeInTheDocument();
    expect(runDbSeed).toHaveBeenCalledWith('/workspace/revealui', postgresUrl);
    expect(update).toHaveBeenCalledWith({ postgresUrl });
  });

  it('cancels confirmation without running migration or seed', async () => {
    render(
      <StepDatabase
        config={MOCK_CONFIG}
        data={{ ...MOCK_DATA, postgresUrl: 'postgresql://selected.invalid/db' }}
        onUpdateData={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect & Migrate' }));
    await screen.findByRole('dialog', { name: 'Run schema migration?' });
    expect(screen.getByRole('textbox', { name: /RevealUI project directory/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(runDbMigrate).not.toHaveBeenCalled();
    expect(runDbSeed).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: /RevealUI project directory/ })).toBeEnabled();
    expect(screen.getByLabelText(/PostgreSQL Connection String/)).toBeEnabled();
  });

  it('does not mutate or publish database data after the connection test fails', async () => {
    vi.mocked(neonTestConnection).mockRejectedValueOnce(new Error('Synthetic connection failure'));
    const update = vi.fn();
    render(
      <StepDatabase
        config={MOCK_CONFIG}
        data={{ ...MOCK_DATA, postgresUrl: 'postgresql://selected.invalid/db' }}
        onUpdateData={update}
        onNext={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect & Migrate' }));
    expect(await screen.findByText('Synthetic connection failure')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(runDbMigrate).not.toHaveBeenCalled();
    expect(runDbSeed).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('renders title and description', () => {
    render(
      <StepDatabase
        config={MOCK_CONFIG}
        data={MOCK_DATA}
        onUpdateData={vi.fn()}
        onNext={vi.fn()}
      />,
    );

    expect(screen.getByText('Provision Database')).toBeInTheDocument();
    expect(screen.getByText('Set up your PostgreSQL database.')).toBeInTheDocument();
  });

  it('renders postgres URL input', () => {
    render(
      <StepDatabase
        config={MOCK_CONFIG}
        data={MOCK_DATA}
        onUpdateData={vi.fn()}
        onNext={vi.fn()}
      />,
    );

    expect(
      screen.getByPlaceholderText('postgres://user:pass@host/db?sslmode=require'),
    ).toBeInTheDocument();
  });

  it('Connect button is disabled when postgres URL is empty', () => {
    render(
      <StepDatabase
        config={MOCK_CONFIG}
        data={MOCK_DATA}
        onUpdateData={vi.fn()}
        onNext={vi.fn()}
      />,
    );

    expect(screen.getByText('Connect & Migrate')).toBeDisabled();
  });

  it('Next button is disabled before database setup completes', () => {
    render(
      <StepDatabase
        config={MOCK_CONFIG}
        data={MOCK_DATA}
        onUpdateData={vi.fn()}
        onNext={vi.fn()}
      />,
    );

    expect(screen.getByText('Next')).toBeDisabled();
  });

  it('enables Connect button when postgres URL is entered', () => {
    render(
      <StepDatabase
        config={MOCK_CONFIG}
        data={MOCK_DATA}
        onUpdateData={vi.fn()}
        onNext={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('postgres://user:pass@host/db?sslmode=require'), {
      target: { value: 'postgres://user:pass@host/db' },
    });

    expect(screen.getByText('Connect & Migrate')).not.toBeDisabled();
  });
});
