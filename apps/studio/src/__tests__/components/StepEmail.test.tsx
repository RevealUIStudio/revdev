import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StepEmail from '../../components/deploy/StepEmail';
import type { StudioConfig, WizardData } from '../../types';

const MOCK_CONFIG: StudioConfig = {
  intent: 'deploy',
  setupComplete: true,
  completedSteps: [],
  deploy: null,
  develop: null,
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

function renderStep(overrides?: Partial<WizardData>) {
  const props = {
    config: MOCK_CONFIG,
    data: { ...MOCK_DATA, ...overrides },
    onUpdateData: vi.fn(),
    onUpdateConfig: vi.fn().mockResolvedValue(undefined),
    onNext: vi.fn().mockResolvedValue(undefined),
  };
  render(<StepEmail {...props} />);
  return props;
}

describe('StepEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Gmail configuration fields', () => {
    renderStep();

    expect(
      screen.getByPlaceholderText('revealui-email@project.iam.gserviceaccount.com'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('-----BEGIN PRIVATE KEY-----')).toBeInTheDocument(); // gitleaks:allow — placeholder text, not a real key
    expect(screen.getByPlaceholderText('noreply@yourdomain.com')).toBeInTheDocument();
  });

  it('surfaces an honest note that in-wizard test send is not wired', () => {
    renderStep();

    expect(screen.getByText(/test send is not wired/i)).toBeInTheDocument();
  });

  it('disables Next until credentials are configured', () => {
    renderStep();

    expect(screen.getByText('Next')).toBeDisabled();
  });

  it('disables Save Config when credentials are empty', () => {
    renderStep();

    expect(screen.getByText('Save Config')).toBeDisabled();
  });

  it('enables Save Config when service account email + private key are filled', () => {
    renderStep();

    fireEvent.change(
      screen.getByPlaceholderText('revealui-email@project.iam.gserviceaccount.com'),
      { target: { value: 'sa@project.iam.gserviceaccount.com' } },
    );
    fireEvent.change(screen.getByPlaceholderText('-----BEGIN PRIVATE KEY-----'), {
      // gitleaks:allow
      target: { value: 'test-private-key-fixture' },
    });

    expect(screen.getByText('Save Config')).not.toBeDisabled();
  });

  it('persists credentials when Save Config is clicked', async () => {
    const { onUpdateData, onUpdateConfig } = renderStep();

    fireEvent.change(
      screen.getByPlaceholderText('revealui-email@project.iam.gserviceaccount.com'),
      { target: { value: 'sa@project.iam.gserviceaccount.com' } },
    );
    fireEvent.change(screen.getByPlaceholderText('-----BEGIN PRIVATE KEY-----'), {
      // gitleaks:allow
      target: { value: 'test-private-key-fixture' },
    });
    fireEvent.click(screen.getByText('Save Config'));

    await waitFor(() => {
      expect(onUpdateData).toHaveBeenCalledWith({
        emailProvider: 'gmail',
        googleServiceAccountEmail: 'sa@project.iam.gserviceaccount.com',
        googlePrivateKey: 'test-private-key-fixture',
        emailFrom: '',
      });
    });
    expect(onUpdateConfig).toHaveBeenCalled();
  });

  it('includes the from-address in the saved config', async () => {
    const { onUpdateData } = renderStep();

    fireEvent.change(
      screen.getByPlaceholderText('revealui-email@project.iam.gserviceaccount.com'),
      { target: { value: 'sa@project.iam.gserviceaccount.com' } },
    );
    fireEvent.change(screen.getByPlaceholderText('-----BEGIN PRIVATE KEY-----'), {
      // gitleaks:allow
      target: { value: 'test-private-key-fixture' },
    });
    fireEvent.change(screen.getByPlaceholderText('noreply@yourdomain.com'), {
      target: { value: 'noreply@example.com' },
    });
    fireEvent.click(screen.getByText('Save Config'));

    await waitFor(() => {
      expect(onUpdateData).toHaveBeenCalledWith(
        expect.objectContaining({
          emailFrom: 'noreply@example.com',
        }),
      );
    });
  });

  it('pre-fills from existing wizard data', () => {
    renderStep({
      googleServiceAccountEmail: 'existing@project.iam.gserviceaccount.com',
      googlePrivateKey: 'existing-key',
      emailFrom: 'noreply@existing.com',
    });

    expect(
      screen.getByPlaceholderText('revealui-email@project.iam.gserviceaccount.com'),
    ).toHaveValue('existing@project.iam.gserviceaccount.com');
    expect(screen.getByPlaceholderText('noreply@yourdomain.com')).toHaveValue(
      'noreply@existing.com',
    );
  });
});
