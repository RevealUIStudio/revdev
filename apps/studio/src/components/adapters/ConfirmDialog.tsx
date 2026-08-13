import { type ReactNode, useId, useState } from 'react';
import Button from './Button';
import Input from './Input';
import Modal from './Modal';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Explanation of what will happen. Keep it concrete and honest. */
  body: ReactNode;
  /** Optional list of the exact items that will be destroyed. */
  affectedItems?: string[];
  /** Label for the destructive confirm button (default "Delete"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * When set, the user must type this exact string before the confirm button
   * enables. Use for the truly irreversible actions (vault secret delete, git
   * discard-all, seeding a database with existing data).
   */
  typeToConfirm?: string;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * A single reusable confirmation gate for destructive actions. Routes every
 * irreversible click (delete a secret, discard working-tree edits, stop the
 * daemon, remove a multi-GB model…) through one explicit, clearly-worded
 * dialog instead of firing on a single hover-click. The optional
 * `typeToConfirm` adds a type-the-name guard for the unrecoverable ones.
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  affectedItems,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  typeToConfirm,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();

  const needsTyping = typeToConfirm != null && typeToConfirm.length > 0;
  const confirmDisabled = needsTyping && typed !== typeToConfirm;

  function handleClose(): void {
    setTyped('');
    onClose();
  }

  function handleConfirm(): void {
    if (confirmDisabled) return;
    setTyped('');
    onConfirm();
  }

  return (
    <Modal
      title={title}
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={handleClose}>
            {cancelLabel}
          </Button>
          <Button type="button" variant="danger" onClick={handleConfirm} disabled={confirmDisabled}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-fg-muted">
        <div>{body}</div>

        {affectedItems && affectedItems.length > 0 && (
          <ul className="max-h-40 list-inside list-disc overflow-y-auto rounded bg-surface-1/60 p-2 font-mono text-xs text-fg-muted">
            {affectedItems.map((item) => (
              <li key={item} className="truncate">
                {item}
              </li>
            ))}
          </ul>
        )}

        {needsTyping && (
          <label htmlFor={inputId} className="block space-y-1">
            <span className="text-xs text-fg-muted">
              Type <span className="font-mono text-fg">{typeToConfirm}</span> to confirm:
            </span>
            <Input
              id={inputId}
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              // biome-ignore lint/a11y/noAutofocus: focusing the gate input is the expected UX
              autoFocus
              mono
            />
          </label>
        )}
      </div>
    </Modal>
  );
}
