import { useCallback, useState } from 'react';

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
      <button
        type="button"
        onClick={dismiss}
        className="absolute right-3 top-3 text-fg-subtle hover:text-fg-muted"
        aria-label="Dismiss welcome message"
      >
        <svg
          className="size-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
      <h2 className="text-sm font-semibold text-brand-text">
        Run your agents on your own infrastructure
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-fg-muted">
        Studio is where you start and watch the AI agents working for you. Each one runs as a user
        you govern, and what it does is recorded so you can check it. This is an early preview, so
        expect a few rough edges.
      </p>
    </div>
  );
}
