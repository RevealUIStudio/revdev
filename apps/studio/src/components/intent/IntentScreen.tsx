import { useState } from 'react';
import Button from '../adapters/Button';
import ErrorAlert from '../adapters/ErrorAlert';

interface IntentScreenProps {
  onSelect: (intent: 'deploy' | 'develop') => Promise<void> | void;
}

export default function IntentScreen({ onSelect }: IntentScreenProps) {
  const [selected, setSelected] = useState<'deploy' | 'develop' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue(): Promise<void> {
    if (!selected) return;
    setError(null);
    setPending(true);
    try {
      await onSelect(selected);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to save your selection. Please try again.',
      );
      setPending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0">
      <div className="w-full max-w-2xl px-8">
        <div className="mb-10 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand text-2xl font-bold text-on-brand">
            R
          </div>
          <h1 className="text-3xl font-bold text-fg">Welcome to RevealUI Studio</h1>
          <p className="mt-2 text-fg-muted">How would you like to use RevealUI?</p>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <button
            type="button"
            onClick={() => setSelected('deploy')}
            className={`rounded-xl border-2 p-6 text-left transition ${
              selected === 'deploy'
                ? 'border-brand bg-surface-2'
                : 'border-edge bg-surface-1 hover:border-edge'
            }`}
          >
            <div className="mb-2 text-2xl">&#x1F680;</div>
            <h2 className="text-lg font-semibold text-fg">Deploy</h2>
            <p className="mt-1 text-sm text-fg-muted">
              I want to run RevealUI for my business. Set up Vercel, database, Stripe, and go live.
            </p>
          </button>

          <button
            type="button"
            onClick={() => setSelected('develop')}
            className={`rounded-xl border-2 p-6 text-left transition ${
              selected === 'develop'
                ? 'border-brand bg-surface-2'
                : 'border-edge bg-surface-1 hover:border-edge'
            }`}
          >
            <div className="mb-2 text-2xl">&#x1F6E0;&#xFE0F;</div>
            <h2 className="text-lg font-semibold text-fg">Develop</h2>
            <p className="mt-1 text-sm text-fg-muted">
              I want to contribute to RevealUI. Set up the dev environment with WSL, Nix, and tools.
            </p>
          </button>
        </div>

        <div className="mt-8 flex flex-col items-center gap-4">
          <ErrorAlert message={error} className="w-full" />
          <Button
            variant="primary"
            size="lg"
            disabled={!selected || pending}
            onClick={() => {
              void handleContinue();
            }}
          >
            {pending ? 'Saving…' : 'Continue'}
          </Button>
        </div>
      </div>
    </div>
  );
}
