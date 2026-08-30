import { IconClose } from '@revealui/presentation';
import { useCallback, useState } from 'react';
import { useSettingsContext } from '../../hooks/use-settings';
import Button from '../adapters/Button';

const STORAGE_KEY = 'revealui-welcome-dismissed';

export default function WelcomeBanner() {
  const { settings } = useSettingsContext();
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
        {settings.localMode
          ? 'You are working on this machine'
          : 'Run your agents on your own infrastructure'}
      </h2>
      {settings.localMode ? (
        <div className="mt-1 space-y-2 text-xs leading-relaxed text-fg-muted">
          <p>Account features stay off until you sign in from Settings.</p>
          <p className="font-medium text-fg">Next</p>
          <ol className="list-decimal space-y-1 pl-4">
            <li>Skip the setup checklist if it covers the window.</li>
            <li>Open Agent in the sidebar.</li>
            <li>Open the Approvals tab on the right.</li>
          </ol>
        </div>
      ) : (
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">
          Studio is where you start your agents and watch them work. Each one runs as a user you
          govern, and every action it takes is recorded so you can check it. This is an early
          preview, so expect a few rough edges.
        </p>
      )}
    </div>
  );
}
