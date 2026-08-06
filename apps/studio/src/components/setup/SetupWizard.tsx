import { useState } from 'react';
import { markSetupComplete, useSetup } from '../../hooks/use-setup';
import Button from '../adapters/Button';
import ConfirmDialog from '../adapters/ConfirmDialog';
import ErrorAlert from '../adapters/ErrorAlert';
import Modal from '../adapters/Modal';
import {
  DevPodRow,
  GitIdentityRow,
  InferenceSnapsRow,
  NixRow,
  ProjectSetupRow,
  TerminalProfileRow,
  VaultRow,
  WslRow,
} from './SetupRows';

interface SetupWizardProps {
  onComplete: () => void;
  onDismiss: () => void;
}

export default function SetupWizard({ onComplete, onDismiss }: SetupWizardProps) {
  const setup = useSetup();
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);

  const allDone =
    setup.status?.wsl_running &&
    setup.status?.nix_installed &&
    setup.status?.devbox_mounted &&
    !!setup.status?.git_name &&
    !!setup.status?.git_email;

  const handleComplete = () => {
    markSetupComplete();
    onComplete();
  };

  const handleSkip = () => {
    if (allDone) {
      onDismiss();
    } else {
      setConfirmingDismiss(true);
    }
  };

  return (
    <>
      <Modal
        title="Setup RevealUI Studio"
        open={true}
        onClose={handleSkip}
        maxWidth="lg"
        footer={
          <>
            <Button variant="ghost" onClick={handleSkip}>
              Skip
            </Button>
            <Button variant="primary" size="lg" onClick={handleComplete} disabled={!allDone}>
              Complete Setup
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {setup.loading && !setup.status && (
            <p className="text-sm text-fg-muted">Checking environment...</p>
          )}

          <ErrorAlert message={setup.error} />

          <WslRow setup={setup} />
          <NixRow setup={setup} />
          <DevPodRow setup={setup} />
          <GitIdentityRow setup={setup} />
          <VaultRow />
          <InferenceSnapsRow />
          <ProjectSetupRow />
          <TerminalProfileRow />
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmingDismiss}
        title="Dismiss setup?"
        body="Setup isn't finished. Dismiss anyway? You can reopen setup later."
        confirmLabel="Dismiss setup"
        cancelLabel="Keep going"
        onConfirm={() => {
          setConfirmingDismiss(false);
          onDismiss();
        }}
        onClose={() => setConfirmingDismiss(false)}
      />
    </>
  );
}
