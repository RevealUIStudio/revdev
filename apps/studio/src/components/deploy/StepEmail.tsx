import { useState } from 'react';
import { gmailSendTest } from '../../lib/deploy';
import type { StudioConfig, WizardData } from '../../types';
import Button from '../adapters/Button';
import Input from '../adapters/Input';
import WizardStep from './WizardStep';

interface StepEmailProps {
  config: StudioConfig;
  data: WizardData;
  onUpdateData: (updates: Partial<WizardData>) => void;
  onUpdateConfig: (updates: Partial<StudioConfig>) => Promise<void>;
  onNext: () => Promise<void>;
}

export default function StepEmail({
  config,
  data,
  onUpdateData,
  onUpdateConfig,
  onNext,
}: StepEmailProps) {
  const [serviceAccountEmail, setServiceAccountEmail] = useState(
    data.googleServiceAccountEmail || '',
  );
  const [privateKey, setPrivateKey] = useState(data.googlePrivateKey || '');
  const [emailFrom, setEmailFrom] = useState(data.emailFrom || '');
  const [testTo, setTestTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<string | null>(
    data.emailVerified ? 'Previous test send succeeded.' : null,
  );

  const isConfigured =
    serviceAccountEmail.trim().length > 0 &&
    privateKey.trim().length > 0 &&
    emailFrom.trim().length > 0;
  const canProbe = isConfigured && testTo.trim().length > 0 && !probing && !loading;

  async function handleSaveConfig() {
    setLoading(true);
    setError(null);

    try {
      if (!isConfigured) {
        setError('Service account email and private key are required');
        return;
      }

      onUpdateData({
        emailProvider: 'gmail',
        googleServiceAccountEmail: serviceAccountEmail.trim(),
        googlePrivateKey: privateKey.trim(),
        emailFrom: emailFrom.trim(),
      });
      await onUpdateConfig({
        deploy: {
          vercelTeamId: config.deploy?.vercelTeamId ?? null,
          domain: config.deploy?.domain ?? null,
          apps: config.deploy?.apps ?? null,
          neonProjectId: config.deploy?.neonProjectId ?? null,
          emailProvider: 'gmail',
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save email config');
    } finally {
      setLoading(false);
    }
  }

  async function handleSendTest() {
    setProbing(true);
    setError(null);
    setProbeResult(null);
    try {
      const result = await gmailSendTest(
        serviceAccountEmail.trim(),
        privateKey.trim(),
        emailFrom.trim(),
        testTo.trim(),
      );
      onUpdateData({
        emailProvider: 'gmail',
        googleServiceAccountEmail: serviceAccountEmail.trim(),
        googlePrivateKey: privateKey.trim(),
        emailFrom: emailFrom.trim(),
        emailVerified: true,
      });
      setProbeResult(`Sent. Gmail message id ${result.messageId}`);
    } catch (err) {
      onUpdateData({ emailVerified: false });
      setError(err instanceof Error ? err.message : 'Test send failed');
    } finally {
      setProbing(false);
    }
  }

  return (
    <WizardStep
      title="Connect Email"
      description="Set up Gmail API for transactional email delivery."
      error={error}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 rounded-md border border-edge bg-surface-1/50 p-4">
          <Input
            id="google-service-account-email"
            label="Service Account Email"
            hint="From your GCP service account JSON key"
            type="email"
            placeholder="revealui-email@project.iam.gserviceaccount.com"
            value={serviceAccountEmail}
            onChange={(e) => setServiceAccountEmail(e.target.value)}
            disabled={loading}
            mono
          />
          <Input
            id="google-private-key"
            label="Private Key"
            hint="RSA private key from service account JSON (PKCS8 PEM)"
            type="password"
            placeholder="-----BEGIN PRIVATE KEY-----"
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            disabled={loading}
            mono
          />
          <Input
            id="email-from"
            label="From Address"
            hint="Must be a Google Workspace user with domain-wide delegation"
            type="email"
            placeholder="noreply@yourdomain.com"
            value={emailFrom}
            onChange={(e) => setEmailFrom(e.target.value)}
            disabled={loading}
          />
        </div>

        <Input
          id="email-test-to"
          label="Send test to"
          hint="A real inbox you can check. Next stays disabled until this send succeeds."
          type="email"
          placeholder="you@yourdomain.com"
          value={testTo}
          onChange={(e) => setTestTo(e.target.value)}
          disabled={probing || loading}
        />

        {probeResult && <p className="text-xs text-success">{probeResult}</p>}

        <div className="flex gap-3 self-end">
          <Button
            variant="secondary"
            onClick={handleSaveConfig}
            loading={loading}
            disabled={!isConfigured || loading}
          >
            Save Config
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleSendTest()}
            loading={probing}
            disabled={!canProbe}
          >
            Send test email
          </Button>
          <Button variant="primary" onClick={onNext} disabled={!data.emailVerified}>
            Next
          </Button>
        </div>
      </div>
    </WizardStep>
  );
}
