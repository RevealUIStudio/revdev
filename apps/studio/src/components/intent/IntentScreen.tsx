import { useState } from 'react';
import Button from '../adapters/Button';
import ErrorAlert from '../adapters/ErrorAlert';

interface IntentScreenProps {
  onSelect: (intent: 'deploy' | 'develop') => Promise<void> | void;
}

export default function IntentScreen({ onSelect }: IntentScreenProps) {
  const [pending, setPending] = useState<'deploy' | 'develop' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSelect(intent: 'deploy' | 'develop'): Promise<void> {
    if (pending) return;
    setError(null);
    setPending(intent);
    try {
      await onSelect(intent);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to save your selection. Please try again.',
      );
      setPending(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0">
      <div className="w-full max-w-2xl px-8">
        <div className="mb-10 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand text-2xl font-bold text-on-brand">
            R
          </div>
          <h1 className="text-3xl font-bold text-fg">How will you use Studio?</h1>
          <p className="mt-2 text-fg-muted">
            Pick a path. One click opens that workspace. You can change this later in Settings.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <Button
            type="button"
            variant="ghost"
            loading={pending === 'develop'}
            disabled={pending !== null}
            onClick={() => {
              handleSelect('develop').catch(() => undefined);
            }}
            className="h-auto rounded-xl border-2 border-edge bg-surface-1 p-6 text-left hover:border-brand"
          >
            <div className="mb-2 text-2xl">&#x1F6E0;&#xFE0F;</div>
            <h2 className="text-lg font-semibold text-fg">Develop</h2>
            <p className="mt-1 text-sm text-fg-muted">
              Work in local repos. This opens the dashboard, then terminal, git, and Agent
              Approvals.
            </p>
          </Button>

          <Button
            type="button"
            variant="ghost"
            loading={pending === 'deploy'}
            disabled={pending !== null}
            onClick={() => {
              handleSelect('deploy').catch(() => undefined);
            }}
            className="h-auto rounded-xl border-2 border-edge bg-surface-1 p-6 text-left hover:border-brand"
          >
            <div className="mb-2 text-2xl">&#x1F680;</div>
            <h2 className="text-lg font-semibold text-fg">Deploy</h2>
            <p className="mt-1 text-sm text-fg-muted">
              Run the guided business setup for Vercel, a database, and Stripe.
            </p>
          </Button>
        </div>

        <div className="mt-8 flex flex-col items-center gap-3">
          <ErrorAlert message={error} className="w-full" />
          <p className="max-w-lg text-center text-sm text-fg-subtle">
            For this machine, choose Develop. A setup checklist may appear next. You can skip it and
            open Agent in the sidebar, then the Approvals tab.
          </p>
        </div>
      </div>
    </div>
  );
}
