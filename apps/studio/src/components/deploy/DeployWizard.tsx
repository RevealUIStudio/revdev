import { IconCheck } from '@revealui/presentation';
import { useState } from 'react';
import { useConfig } from '../../hooks/use-config';
import { useDeployWizard } from '../../hooks/use-deploy-wizard';
import type { WizardData } from '../../types';
import Button from '../adapters/Button';
import StepBlob from './StepBlob';
import StepDatabase from './StepDatabase';
import StepDeploy from './StepDeploy';
import StepDomain from './StepDomain';
import StepEmail from './StepEmail';
import StepSecrets from './StepSecrets';
import StepStripe from './StepStripe';
import StepVercel from './StepVercel';
import StepVerify from './StepVerify';

interface DeployWizardProps {
  onComplete: () => void;
}

const EMPTY_WIZARD_DATA: WizardData = {
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
  signupWhitelist: undefined,
  brandColor: undefined,
  brandLogo: undefined,
};

export default function DeployWizard({ onComplete }: DeployWizardProps) {
  const { config, updateConfig } = useConfig();
  const [data, setData] = useState<WizardData>(EMPTY_WIZARD_DATA);
  const wizard = useDeployWizard(config);

  if (!config) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-0">
        <div className="text-fg-muted">Loading...</div>
      </div>
    );
  }

  const updateData = (updates: Partial<WizardData>) => {
    setData((prev) => ({ ...prev, ...updates }));
  };

  const stepComponents: Record<string, React.ReactNode> = {
    vercel: (
      <StepVercel
        config={config}
        data={data}
        onUpdateData={updateData}
        onUpdateConfig={updateConfig}
        onNext={wizard.next}
      />
    ),
    database: (
      <StepDatabase config={config} data={data} onUpdateData={updateData} onNext={wizard.next} />
    ),
    stripe: (
      <StepStripe config={config} data={data} onUpdateData={updateData} onNext={wizard.next} />
    ),
    email: (
      <StepEmail
        config={config}
        data={data}
        onUpdateData={updateData}
        onUpdateConfig={updateConfig}
        onNext={wizard.next}
      />
    ),
    blob: <StepBlob data={data} onUpdateData={updateData} onNext={wizard.next} />,
    secrets: <StepSecrets data={data} onUpdateData={updateData} onNext={wizard.next} />,
    domain: (
      <StepDomain
        config={config}
        data={data}
        onUpdateData={updateData}
        onUpdateConfig={updateConfig}
        onNext={wizard.next}
      />
    ),
    deploy: <StepDeploy config={config} data={data} onNext={wizard.next} />,
    verify: <StepVerify config={config} data={data} onComplete={onComplete} />,
  };

  return (
    <div className="fixed inset-0 z-50 flex bg-surface-0">
      <div className="w-64 border-r border-edge bg-surface-1 p-4">
        <h1 className="mb-6 text-lg font-bold text-fg">Deploy RevealUI</h1>
        <nav aria-label="Deploy progress" className="flex flex-col gap-1">
          {wizard.steps.map((s, i) => {
            const done = wizard.isStepDone(s.id);
            const active = i === wizard.currentStep;
            return (
              <Button
                type="button"
                variant="ghost"
                key={s.id}
                onClick={() => wizard.goTo(i)}
                aria-current={active ? 'step' : undefined}
                className={`flex h-auto w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${
                  active
                    ? 'bg-surface-2 text-fg'
                    : done
                      ? 'text-success hover:bg-surface-2'
                      : 'text-fg-subtle hover:bg-surface-2'
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs transition ${
                    done
                      ? 'border-0 bg-success text-fg'
                      : active
                        ? 'border-2 border-brand text-brand'
                        : 'border border-edge-strong text-fg-subtle'
                  }`}
                >
                  {done ? <IconCheck size="sm" className="size-3.5" /> : i + 1}
                </span>
                {s.label}
              </Button>
            );
          })}
        </nav>
        <div className="mt-auto pt-4 text-center text-xs text-fg-subtle">
          Step {wizard.currentStep + 1} of {wizard.steps.length}
        </div>
      </div>

      <div className="flex flex-1 flex-col p-8">
        <div className="flex-1 overflow-y-auto">
          {wizard.step && stepComponents[wizard.step.id]}
        </div>

        <div className="mt-6 flex items-center border-t border-edge pt-4">
          <Button variant="ghost" disabled={wizard.isFirst} onClick={wizard.back}>
            Back
          </Button>
        </div>
      </div>
    </div>
  );
}
