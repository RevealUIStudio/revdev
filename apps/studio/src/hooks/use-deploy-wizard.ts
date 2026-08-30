import { useEffect, useState } from 'react';
import { completeStep, isStepComplete } from '../lib/config';
import type { DeployStep, StudioConfig } from '../types';

const DEPLOY_STEPS: { id: DeployStep; label: string }[] = [
  { id: 'vercel', label: 'Connect Vercel' },
  { id: 'database', label: 'Provision Database' },
  { id: 'stripe', label: 'Connect Stripe' },
  { id: 'email', label: 'Connect Email' },
  { id: 'blob', label: 'Blob Storage' },
  { id: 'secrets', label: 'Generate Secrets' },
  { id: 'domain', label: 'Domain & CORS' },
  { id: 'deploy', label: 'Deploy' },
  { id: 'verify', label: 'Verify' },
];

function firstOpenIndex(config: StudioConfig | null): number {
  if (!config) return 0;
  const idx = DEPLOY_STEPS.findIndex((s) => !isStepComplete(config, s.id));
  return idx === -1 ? DEPLOY_STEPS.length - 1 : idx;
}

export function useDeployWizard(
  config: StudioConfig | null,
  options: { reload?: () => Promise<void> } = {},
) {
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [hasResumed, setHasResumed] = useState(false);
  const reload = options.reload;

  // Auto-resume to first incomplete step once config loads
  useEffect(() => {
    if (!config || hasResumed) return;
    const idx = firstOpenIndex(config);
    if (idx > 0) setCurrentStep(idx);
    setHasResumed(true);
  }, [config, hasResumed]);

  const step = DEPLOY_STEPS[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === DEPLOY_STEPS.length - 1;

  const markComplete = async () => {
    if (step) {
      await completeStep(step.id);
      if (reload) await reload();
    }
  };

  const next = async () => {
    await markComplete();
    if (!isLast) setCurrentStep((i) => i + 1);
  };

  const back = () => {
    if (!isFirst) setCurrentStep((i) => i - 1);
  };

  const goTo = (index: number) => {
    const max = firstOpenIndex(config);
    if (index < 0 || index > max) return;
    setCurrentStep(index);
  };

  return {
    steps: DEPLOY_STEPS,
    currentStep,
    step,
    isFirst,
    isLast,
    next,
    back,
    goTo,
    markComplete,
    isStepDone: (id: DeployStep) => (config ? isStepComplete(config, id) : false),
  };
}
