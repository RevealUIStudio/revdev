import { Textarea } from '@revealui/presentation';
import { useState } from 'react';
import Button from '../adapters/Button';
import ErrorAlert from '../adapters/ErrorAlert';
import Input from '../adapters/Input';
import Modal from '../adapters/Modal';

interface CreateSecretDialogProps {
  // Returns true on success; on false the dialog stays open and preserves input
  // so a failed save no longer silently closes the form (the #200
  // resolve-on-failure finding). The error itself is surfaced by the vault hook.
  onConfirm: (path: string, value: string) => Promise<boolean>;
  onClose: () => void;
}

export default function CreateSecretDialog({ onConfirm, onClose }: CreateSecretDialogProps) {
  const [path, setPath] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(path.trim() && value.trim())) return;
    setSaving(true);
    setError(null);
    try {
      if (await onConfirm(path.trim(), value.trim())) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="New Secret"
      open={true}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="lg"
            onClick={(e) => handleSubmit(e as unknown as React.FormEvent)}
            disabled={saving || !path.trim() || !value.trim()}
            loading={saving}
          >
            Save Secret
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <ErrorAlert message={error} />

        <Input
          id="secret-path"
          label="Path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="namespace/key-name"
          mono
          autoFocus
        />

        <div>
          <label htmlFor="secret-value" className="mb-1 block text-xs font-medium text-fg-muted">
            Value
          </label>
          <Textarea
            id="secret-value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Secret value..."
            rows={3}
            className="[&_textarea]:font-mono"
          />
        </div>
      </form>
    </Modal>
  );
}
