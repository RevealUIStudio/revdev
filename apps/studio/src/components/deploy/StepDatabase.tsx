import { useState } from 'react';
import { neonTestConnection, runDbMigrate, runDbSeed } from '../../lib/deploy';
import type { StudioConfig, WizardData } from '../../types';
import Button from '../adapters/Button';
import ConfirmDialog from '../adapters/ConfirmDialog';
import Input from '../adapters/Input';
import WizardStep from './WizardStep';

type Phase = 'input' | 'testing' | 'migrating' | 'seeding' | 'done';

const PHASE_LABELS: Record<Phase, string> = {
  input: '',
  testing: 'Testing connection...',
  migrating: 'Running migrations...',
  seeding: 'Seeding database...',
  done: 'Database ready',
};

interface StepDatabaseProps {
  config: StudioConfig;
  data: WizardData;
  onUpdateData: (updates: Partial<WizardData>) => void;
  onNext: () => Promise<void>;
}

export default function StepDatabase({ config, data, onUpdateData, onNext }: StepDatabaseProps) {
  const [postgresUrl, setPostgresUrl] = useState(data.postgresUrl || '');
  const [repoPath, setRepoPath] = useState(config.develop?.repoPath ?? '');
  const [target, setTarget] = useState<{ repoPath: string; connectionString: string } | null>(null);
  const [phase, setPhase] = useState<Phase>('input');
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<'migrate' | 'seed' | null>(null);

  const isRunning = phase !== 'input' && phase !== 'done';

  async function handleConnect() {
    if (!postgresUrl.trim() || !repoPath.trim()) return;

    setError(null);
    setTarget(null);
    const selected = { repoPath: repoPath.trim(), connectionString: postgresUrl.trim() };

    try {
      setPhase('testing');
      await neonTestConnection(selected.connectionString);
      setTarget(selected);
      setPendingAction('migrate');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Database setup failed');
      setPhase('input');
    }
  }

  async function handleConfirmMigrate() {
    if (pendingAction !== 'migrate' || target === null) return;
    setPendingAction(null);
    setError(null);

    try {
      setPhase('migrating');
      await runDbMigrate(target.repoPath, target.connectionString);
      setPendingAction('seed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Migration failed');
      setPhase('input');
    }
  }

  async function handleConfirmSeed() {
    if (pendingAction !== 'seed' || target === null) return;
    setPendingAction(null);
    setError(null);

    try {
      setPhase('seeding');
      await runDbSeed(target.repoPath, target.connectionString);

      setPhase('done');
      onUpdateData({
        postgresUrl: target.connectionString,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Seeding failed');
      setPhase('input');
    }
  }

  function handleDialogClose() {
    setTarget(null);
    setPendingAction(null);
    setPhase('input');
  }

  let databaseTarget = 'Selected database';
  try {
    const url = new URL(target?.connectionString ?? '');
    databaseTarget = `${url.host}${url.pathname}`;
  } catch {
    // The native connection test reports invalid URLs before confirmation.
  }

  return (
    <WizardStep
      title="Provision Database"
      description="Set up your PostgreSQL database."
      error={error}
    >
      <div className="flex flex-col gap-4">
        <Input
          id="database-project-path"
          label="RevealUI project directory"
          hint="Workspace root containing package.json and pnpm-workspace.yaml"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          disabled={isRunning || phase === 'done'}
          mono
        />
        <Input
          id="postgres-url"
          label="PostgreSQL Connection String"
          hint="from Neon dashboard"
          type="password"
          placeholder="postgres://user:pass@host/db?sslmode=require"
          value={postgresUrl}
          onChange={(e) => setPostgresUrl(e.target.value)}
          disabled={isRunning || phase === 'done'}
          mono
        />

        {phase !== 'input' && phase !== 'done' && (
          <p className="text-sm text-warning">{PHASE_LABELS[phase]}</p>
        )}

        {phase === 'done' && <p className="text-sm text-success">{PHASE_LABELS.done}</p>}

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            onClick={handleConnect}
            loading={isRunning}
            disabled={!postgresUrl.trim() || !repoPath.trim() || isRunning || phase === 'done'}
          >
            Connect &amp; Migrate
          </Button>
        </div>

        <Button
          variant="primary"
          onClick={onNext}
          disabled={phase !== 'done'}
          className="mt-2 self-end"
        >
          Next
        </Button>
      </div>

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction === 'seed' ? 'Seed database?' : 'Run schema migration?'}
        body={
          <>
            <p>Database: {databaseTarget}</p>
            <p>Project: {target?.repoPath}</p>
            <p>
              {pendingAction === 'seed'
                ? 'Seeding will insert or replace rows in this database. Existing data in seeded tables may be overwritten and cannot be recovered.'
                : 'This will apply pending schema migrations to this database, altering its structure. Ensure you have a backup before proceeding.'}
            </p>
          </>
        }
        confirmLabel={pendingAction === 'seed' ? 'Seed database' : 'Run migration'}
        typeToConfirm={pendingAction === 'seed' ? 'seed' : undefined}
        onConfirm={pendingAction === 'seed' ? handleConfirmSeed : handleConfirmMigrate}
        onClose={handleDialogClose}
      />
    </WizardStep>
  );
}
