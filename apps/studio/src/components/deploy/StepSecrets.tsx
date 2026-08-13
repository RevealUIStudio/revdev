import { IconCheck } from '@revealui/presentation';
import { useState } from 'react';
import { generateKek, generateSecret } from '../../lib/deploy';
import type { WizardData } from '../../types';
import Button from '../adapters/Button';
import WizardStep from './WizardStep';

interface StepSecretsProps {
  data: WizardData;
  onUpdateData: (updates: Partial<WizardData>) => void;
  onNext: () => Promise<void>;
}

export default function StepSecrets({ data, onUpdateData, onNext }: StepSecretsProps) {
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(
    Boolean(data.revealuiSecret && data.revealuiKek && data.cronSecret),
  );
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);

    try {
      const [revealuiSecret, revealuiKek, cronSecret] = await Promise.all([
        generateSecret(48),
        generateKek(),
        generateSecret(48),
      ]);

      onUpdateData({ revealuiSecret, revealuiKek, cronSecret });
      setGenerated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate secrets');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <WizardStep
      title="Generate Secrets"
      description="Generate encryption keys and secrets for your deployment."
      error={error}
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-edge bg-surface-1/50 p-4 text-sm text-fg-muted">
          <p className="mb-2 font-medium text-fg-muted">Three secrets will be generated:</p>
          <ul className="list-inside list-disc flex flex-col gap-1">
            <li>
              <span className="text-fg">REVEALUI_SECRET</span> — session signing key
            </li>
            <li>
              <span className="text-fg">REVEALUI_KEK</span> — key encryption key (AES-256)
            </li>
            <li>
              <span className="text-fg">REVEALUI_CRON_SECRET</span> — cron job authentication
            </li>
          </ul>
        </div>

        {generated && (
          <div className="flex flex-col gap-2">
            <SecretRow label="REVEALUI_SECRET" />
            <SecretRow label="REVEALUI_KEK" />
            <SecretRow label="REVEALUI_CRON_SECRET" />
          </div>
        )}

        {!generated && (
          <Button
            variant="primary"
            onClick={handleGenerate}
            loading={generating}
            disabled={generating}
          >
            Generate All Secrets
          </Button>
        )}

        <Button variant="primary" onClick={onNext} disabled={!generated} className="mt-2 self-end">
          Next
        </Button>
      </div>
    </WizardStep>
  );
}

function SecretRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-success/50 bg-success-subtle px-3 py-2">
      <IconCheck size="sm" className="shrink-0 text-success" />
      <span className="text-sm font-mono text-fg-muted">{label}</span>
      <span className="text-xs text-success">Generated</span>
    </div>
  );
}
