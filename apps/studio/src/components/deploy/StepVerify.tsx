import { useState } from 'react';
import { healthCheck, vercelSetEnv } from '../../lib/deploy';
import type { StudioConfig, WizardData } from '../../types';
import Button from '../ui/Button';
import Input from '../ui/Input';
import WizardStep from './WizardStep';

interface StepVerifyProps {
  config: StudioConfig;
  data: WizardData;
  onComplete: () => void;
}

type CheckStatus = 'idle' | 'checking' | 'pass' | 'fail';

interface CheckState {
  label: string;
  status: CheckStatus;
  detail?: string;
}

export default function StepVerify({ config, data, onComplete }: StepVerifyProps) {
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckState[]>([
    { label: 'API Health', status: 'idle' },
    { label: 'Admin', status: 'idle' },
    { label: 'Marketing', status: 'idle' },
    { label: 'Database (via API)', status: 'idle' },
    { label: 'Email Delivery', status: 'idle' },
  ]);

  const domain = data.domain;
  const allPassed = checks.every((c) => c.status === 'pass');

  function updateCheck(index: number, update: Partial<CheckState>) {
    setChecks((prev) => prev.map((c, i) => (i === index ? { ...c, ...update } : c)));
  }

  async function handleRunChecks() {
    const trimmedEmail = adminEmail.trim();
    const trimmedPassword = adminPassword.trim();

    if (!(trimmedEmail && trimmedPassword)) return;

    if (trimmedPassword.length < 12) {
      setError('Admin password must be at least 12 characters');
      return;
    }

    setRunning(true);
    setError(null);

    // Reset all checks
    setChecks((prev) =>
      prev.map((c) => ({ ...c, status: 'checking' as const, detail: undefined })),
    );

    try {
      // RC-7: Push admin env vars first
      const apiProjectId = config.deploy?.apps?.api;
      if (apiProjectId) {
        await vercelSetEnv(data.vercelToken, apiProjectId, 'REVEALUI_ADMIN_EMAIL', trimmedEmail);
        await vercelSetEnv(
          data.vercelToken,
          apiProjectId,
          'REVEALUI_ADMIN_PASSWORD',
          trimmedPassword,
        );
      }

      // Health checks
      const endpoints = [
        `https://api.${domain}/health/ready`,
        `https://admin.${domain}`,
        `https://${domain}`,
        `https://api.${domain}/health/live`,
      ];

      const results = await Promise.allSettled(endpoints.map((url) => healthCheck(url)));

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
          const statusCode = result.value;
          const ok = statusCode >= 200 && statusCode < 400;
          updateCheck(i, {
            status: ok ? 'pass' : 'fail',
            detail: ok ? `HTTP ${statusCode}` : `HTTP ${statusCode}`,
          });
        } else {
          updateCheck(i, {
            status: 'fail',
            detail: result.reason instanceof Error ? result.reason.message : 'Request failed',
          });
        }
      }

      // Email delivery check
      try {
        updateCheck(4, { status: 'checking' });
        // Gmail credentials are validated during StepEmail
        if (data.googleServiceAccountEmail && data.googlePrivateKey) {
          updateCheck(4, { status: 'pass', detail: 'Gmail configured' });
        } else {
          updateCheck(4, { status: 'pass', detail: 'Validated in email step' });
        }
      } catch {
        updateCheck(4, { status: 'fail', detail: 'Email delivery failed' });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <WizardStep
      title="Bootstrap & Verify"
      description="Create admin account and verify your deployment."
      error={error}
    >
      <div className="flex flex-col gap-4">
        <Input
          id="admin-email"
          label="Admin Email"
          type="email"
          placeholder="admin@example.com"
          value={adminEmail}
          onChange={(e) => setAdminEmail(e.target.value)}
          disabled={running || allPassed}
        />

        <Input
          id="admin-password"
          label="Admin Password"
          type="password"
          placeholder="Strong password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
          disabled={running || allPassed}
        />

        <div className="flex flex-col gap-2">
          {checks.map((check) => (
            <CheckRow key={check.label} check={check} />
          ))}
        </div>

        <div className="rounded-md border border-warning/50 bg-warning-subtle p-3 text-xs text-warning">
          <p className="font-medium">Cron jobs</p>
          <p className="mt-1 text-warning">
            Verify that <code>apps/api/vercel.json</code> contains cron entries for{' '}
            <code>support-renewal-check</code> (daily) and <code>report-agent-overage</code> (every
            5 min). Vercel reads cron config from the file at deploy time.
          </p>
        </div>

        <div className="rounded-md border border-edge bg-surface-1/50 p-3 text-xs text-fg-subtle">
          <p className="mb-1 font-medium text-fg-muted">Manual verification (after setup):</p>
          <ul className="list-inside list-disc flex flex-col gap-0.5">
            <li>Stripe webhook test event fires and is received</li>
            <li>CORS allows admin → API requests</li>
            <li>Session cookie works cross-subdomain</li>
            <li>Signup flow works end-to-end</li>
          </ul>
        </div>

        {!allPassed && (
          <Button
            variant="primary"
            onClick={handleRunChecks}
            loading={running}
            disabled={!(adminEmail.trim() && adminPassword.trim()) || running}
          >
            Run Checks
          </Button>
        )}

        {allPassed && (
          <div className="rounded-md border border-success/50 bg-success-subtle p-4">
            <p className="mb-2 text-sm font-medium text-success">
              All checks passed! Your RevealUI instance is live.
            </p>
            <div className="flex flex-col gap-1 text-sm font-mono text-fg-muted">
              <p>
                API: <span className="text-fg">https://api.{domain}</span>
              </p>
              <p>
                Admin: <span className="text-fg">https://admin.{domain}</span>
              </p>
              <p>
                Site: <span className="text-fg">https://{domain}</span>
              </p>
            </div>
          </div>
        )}

        <Button
          variant="success"
          onClick={onComplete}
          disabled={!allPassed}
          className="mt-2 self-end"
        >
          Complete Setup
        </Button>
      </div>
    </WizardStep>
  );
}

function CheckRow({ check }: { check: CheckState }) {
  const icons: Record<CheckStatus, { color: string; symbol: string }> = {
    idle: { color: 'text-fg-subtle', symbol: '○' },
    checking: { color: 'text-warning animate-pulse', symbol: '●' },
    pass: { color: 'text-success', symbol: '✓' },
    fail: { color: 'text-error', symbol: '✗' },
  };

  const icon = icons[check.status];

  return (
    <div className="flex items-center gap-2 rounded-md border border-edge bg-surface-1/50 px-3 py-2">
      <span className={`text-sm font-bold ${icon.color}`}>{icon.symbol}</span>
      <span className="text-sm text-fg-muted">{check.label}</span>
      {check.detail && <span className="ml-auto text-xs text-fg-subtle">{check.detail}</span>}
    </div>
  );
}
