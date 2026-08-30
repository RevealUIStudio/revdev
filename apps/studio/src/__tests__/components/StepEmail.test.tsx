import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StepEmail from '../../components/deploy/StepEmail';
import type { StudioConfig, WizardData } from '../../types';

const mockGmailSendTest = vi.fn();
vi.mock('../../lib/deploy', () => ({
  gmailSendTest: (...args: unknown[]) => mockGmailSendTest(...args),
}));

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
    mockGmailSendTest.mockResolvedValue({ messageId: 'msg-1', sentAt: '1' });
  });

  it('renders Gmail configuration fields', () => {
    renderStep();

    expect(
      screen.getByPlaceholderText('revealui-email@project.iam.gserviceaccount.com'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('-----BEGIN PRIVATE KEY-----')).toBeInTheDocument(); // gitleaks:allow — placeholder text, not a real key
    expect(screen.getByPlaceholderText('noreply@yourdomain.com')).toBeInTheDocument();
  });

  it('disables Next until a real test send succeeds', () => {
    renderStep();

    expect(screen.getByText('Next')).toBeDisabled();
  });

  it('enables Next when emailVerified is already true', () => {
    renderStep({ emailVerified: true });

    expect(screen.getByText('Next')).not.toBeDisabled();
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

    fireEvent.change(screen.getByPlaceholderText('noreply@yourdomain.com'), {
      target: { value: 'noreply@example.com' },
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
    fireEvent.change(screen.getByPlaceholderText('noreply@yourdomain.com'), {
      target: { value: 'noreply@example.com' },
    });
    fireEvent.click(screen.getByText('Save Config'));

    await waitFor(() => {
      expect(onUpdateData).toHaveBeenCalledWith({
        emailProvider: 'gmail',
        googleServiceAccountEmail: 'sa@project.iam.gserviceaccount.com',
        googlePrivateKey: 'test-private-key-fixture',
        emailFrom: 'noreply@example.com',
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

  it('keeps Send test email disabled until a recipient is set', () => {
    renderStep({
      googleServiceAccountEmail: 'sa@project.iam.gserviceaccount.com',
      googlePrivateKey: 'test-private-key-fixture',
      emailFrom: 'noreply@example.com',
    });

    expect(screen.getByRole('button', { name: /send test email/i })).toBeDisabled();
  });

  it('records a message id after a successful probe', async () => {
    const { onUpdateData } = renderStep({
      googleServiceAccountEmail: 'sa@project.iam.gserviceaccount.com',
      googlePrivateKey: 'test-private-key-fixture',
      emailFrom: 'noreply@example.com',
    });

    fireEvent.change(screen.getByPlaceholderText('you@yourdomain.com'), {
      target: { value: 'you@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send test email/i }));

    await waitFor(() => {
      expect(mockGmailSendTest).toHaveBeenCalledWith(
        'sa@project.iam.gserviceaccount.com',
        'test-private-key-fixture',
        'noreply@example.com',
        'you@example.com',
      );
    });
    expect(onUpdateData).toHaveBeenCalledWith(expect.objectContaining({ emailVerified: true }));
    expect(screen.getByText(/Gmail message id msg-1/)).toBeInTheDocument();
  });

  it('surfaces a probe failure and does not mark verified', async () => {
    mockGmailSendTest.mockRejectedValueOnce(new Error('Delegation failed (HTTP 401)'));
    const { onUpdateData } = renderStep({
      googleServiceAccountEmail: 'sa@project.iam.gserviceaccount.com',
      googlePrivateKey: 'test-private-key-fixture',
      emailFrom: 'noreply@example.com',
    });

    fireEvent.change(screen.getByPlaceholderText('you@yourdomain.com'), {
      target: { value: 'you@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send test email/i }));

    await waitFor(() => {
      expect(screen.getByText(/Delegation failed/)).toBeInTheDocument();
    });
    expect(onUpdateData).toHaveBeenCalledWith({ emailVerified: false });
    expect(screen.getByText('Next')).toBeDisabled();
  });
});
