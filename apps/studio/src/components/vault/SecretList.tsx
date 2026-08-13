import { IconTrash } from '@revealui/presentation';
import { useState } from 'react';
import type { SecretInfo } from '../../types';
import Button from '../adapters/Button';
import ConfirmDialog from '../adapters/ConfirmDialog';

interface SecretListProps {
  secrets: SecretInfo[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onDelete: (path: string) => void;
}

export default function SecretList({ secrets, selectedPath, onSelect, onDelete }: SecretListProps) {
  // The hover trash icon used to delete a stored secret on a single click with
  // no undo. Gate it behind a type-to-confirm dialog (the secret key name).
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  if (secrets.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-fg-subtle">
        No secrets found
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
        {secrets.map((secret) => (
          <div
            key={secret.path}
            className={`group flex items-center justify-between rounded px-3 py-2 transition-colors ${
              selectedPath === secret.path
                ? 'bg-surface-2 text-fg'
                : 'text-fg-muted hover:bg-surface-3 hover:text-fg'
            }`}
          >
            <Button
              type="button"
              variant="ghost"
              className="h-auto flex-1 justify-start p-0 text-left"
              onClick={() => onSelect(secret.path)}
            >
              <span className="block w-full">
                <p className="truncate text-sm font-medium">{secret.path.split('/').pop()}</p>
                <p className="truncate text-xs text-fg-subtle">{secret.path}</p>
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setPendingDelete(secret.path);
              }}
              className="ml-2 hidden rounded p-1 text-fg-subtle transition-colors hover:bg-error-subtle hover:text-error group-hover:flex"
              aria-label={`Delete ${secret.path}`}
            >
              <IconTrash size="sm" className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete secret"
        body={
          <>
            Permanently delete <span className="font-mono text-fg">{pendingDelete}</span>? This
            destroys the stored value with no undo.
          </>
        }
        confirmLabel="Delete secret"
        typeToConfirm={pendingDelete?.split('/').pop() ?? undefined}
        onConfirm={() => {
          if (pendingDelete) onDelete(pendingDelete);
          setPendingDelete(null);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </>
  );
}
