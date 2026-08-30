import { useState } from 'react';
import { markSetupComplete, useSetup } from '../../hooks/use-setup';
import { daemonSetup, invokeErrorMessage } from '../../lib/invoke';
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
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  // Checklist rows are environment hints, not a gate. Linux/macOS check_setup
  // never reports wsl_running or a mounted Studio drive, so requiring allDone
  // made Complete Setup unreachable on a Tauri daily-driver.
  const allDone =
    setup.status?.wsl_running &&
    setup.status?.nix_installed &&
    setup.status?.devbox_mounted &&
    !!setup.status?.git_name &&
    !!setup.status?.git_email;

  const handleComplete = () => {
    setProvisioning(true);
    setProvisionError(null);
    void daemonSetup()
      .then(() => {
        markSetupComplete();
        onComplete();
      })
      .catch((err: unknown) => {
        setProvisionError(invokeErrorMessage(err));
      })
      .finally(() => {
        setProvisioning(false);
      });
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
            <Button
              variant="primary"
              size="lg"
              onClick={handleComplete}
              disabled={provisioning}
              loading={provisioning}
            >
              Complete Setup
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-fg-muted">
            Completing Setup installs the agent relay (no-op on native Unix) and continues into
            Studio. WSL, Nix, DevPod, and git identity are optional checks — they do not block
            Complete. Skip hides the wizard for this launch. Agent Approvals live under Agent in the
            sidebar.
          </p>
          {setup.loading && !setup.status && (
            <p className="text-sm text-fg-muted">Checking environment...</p>
          )}

          <ErrorAlert message={setup.error ?? provisionError} />

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
        body="Setup is not finished. Dismiss anyway? You can reopen Setup from the sidebar. Agent Approvals are under Agent."
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
