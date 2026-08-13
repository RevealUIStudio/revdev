import { IconClose } from '@revealui/presentation';
import { useCallback, useState } from 'react';
import Button from '../adapters/Button';

const STORAGE_KEY = 'revealui-welcome-dismissed';

export default function WelcomeBanner() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(STORAGE_KEY) === '1');

  const dismiss = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, '1');
    setDismissed(true);
  }, []);

  if (dismissed) return null;

  return (
    <div className="relative rounded-lg border border-brand/40 bg-brand-subtle px-5 py-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={dismiss}
        className="absolute right-3 top-3 p-1 text-fg-subtle hover:text-fg-muted"
        aria-label="Dismiss welcome message"
      >
        <IconClose size="sm" />
      </Button>
      <h2 className="text-sm font-semibold text-brand-text">
        Run your agents on your own infrastructure
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-fg-muted">
        Studio is where you start your agents and watch them work. Each one runs as a user you
        govern, and every action it takes is recorded so you can check it. This is an early preview,
        so expect a few rough edges.
      </p>
    </div>
  );
}
