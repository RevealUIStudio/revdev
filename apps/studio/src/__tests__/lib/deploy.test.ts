import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDegradedModeForTests, isDegradedMode } from '../../lib/degraded-mode';
import * as deploy from '../../lib/deploy';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

interface Operation {
  name: string;
  run: () => Promise<unknown>;
  command: string;
  args?: Record<string, unknown>;
  result: unknown;
}

const operations: Operation[] = [
  {
    name: 'Vercel token validation',
    run: () => deploy.vercelValidateToken('token'),
    command: 'vercel_validate_token',
    args: { token: 'token' },
    result: [],
  },
  {
    name: 'blob token validation',
    run: () => deploy.vercelValidateBlobToken('blob-token'),
    command: 'vercel_validate_blob_token',
    args: { token: 'blob-token' },
    result: false,
  },
  {
    name: 'project creation',
    run: () => deploy.vercelCreateProject('token', 'site', 'nextjs', 'apps/admin'),
    command: 'vercel_create_project',
    args: { token: 'token', name: 'site', framework: 'nextjs', rootDirectory: 'apps/admin' },
    result: { id: 'project-id', name: 'site', framework: 'nextjs', accountId: 'team-id' },
  },
  {
    name: 'project creation without a root directory',
    run: () => deploy.vercelCreateProject('token', 'site', 'nextjs'),
    command: 'vercel_create_project',
    args: { token: 'token', name: 'site', framework: 'nextjs', rootDirectory: null },
    result: { id: 'project-id', name: 'site', framework: 'nextjs', accountId: 'team-id' },
  },
  {
    name: 'environment write with default targets',
    run: () => deploy.vercelSetEnv('token', 'project-id', 'EXAMPLE_KEY', 'value'),
    command: 'vercel_set_env',
    args: {
      token: 'token',
      projectId: 'project-id',
      key: 'EXAMPLE_KEY',
      value: 'value',
      target: ['production', 'preview', 'development'],
    },
    result: undefined,
  },
  {
    name: 'environment write with explicit targets',
    run: () => deploy.vercelSetEnv('token', 'project-id', 'EXAMPLE_KEY', 'value', ['production']),
    command: 'vercel_set_env',
    args: {
      token: 'token',
      projectId: 'project-id',
      key: 'EXAMPLE_KEY',
      value: 'value',
      target: ['production'],
    },
    result: undefined,
  },
  {
    name: 'deployment creation',
    run: () => deploy.vercelDeploy('token', 'project-id'),
    command: 'vercel_deploy',
    args: { token: 'token', projectId: 'project-id' },
    result: 'deployment-id',
  },
  {
    name: 'deployment status',
    run: () => deploy.vercelGetDeployment('token', 'deployment-id'),
    command: 'vercel_get_deployment',
    args: { token: 'token', deploymentId: 'deployment-id' },
    result: { uid: 'deployment-id', url: 'site.example.com', state: 'ERROR', created: 1n },
  },
  {
    name: 'database connection test',
    run: () => deploy.neonTestConnection('postgresql://selected.invalid/db'),
    command: 'neon_test_connection',
    args: { connectionString: 'postgresql://selected.invalid/db' },
    result: 'database response',
  },
  {
    name: 'database migration',
    run: () => deploy.runDbMigrate('/repo', 'postgresql://selected.invalid/db'),
    command: 'run_db_migrate',
    args: { repoPath: '/repo', connectionString: 'postgresql://selected.invalid/db' },
    result: 'migration response',
  },
  {
    name: 'database seed',
    run: () => deploy.runDbSeed('/repo', 'postgresql://selected.invalid/db'),
    command: 'run_db_seed',
    args: { repoPath: '/repo', connectionString: 'postgresql://selected.invalid/db' },
    result: 'seed response',
  },
  {
    name: 'Stripe key validation',
    run: () => deploy.stripeValidateKeys('stripe-key'),
    command: 'stripe_validate_keys',
    args: { secretKey: 'stripe-key' },
    result: false,
  },
  {
    name: 'Stripe seed',
    run: () => deploy.stripeRunSeed('/repo'),
    command: 'stripe_run_seed',
    args: { repoPath: '/repo' },
    result: 'Stripe seed response',
  },
  {
    name: 'Stripe key generation',
    run: () => deploy.stripeRunKeys('/repo'),
    command: 'stripe_run_keys',
    args: { repoPath: '/repo' },
    result: 'Stripe key response',
  },
  {
    name: 'Stripe catalog sync',
    run: () => deploy.stripeCatalogSync('/repo'),
    command: 'stripe_catalog_sync',
    args: { repoPath: '/repo' },
    result: 'catalog response',
  },
  {
    name: 'Resend test send',
    run: () => deploy.resendSendTest('email-key', 'test@example.com'),
    command: 'resend_send_test',
    args: { apiKey: 'email-key', toEmail: 'test@example.com' },
    result: false,
  },
  {
    name: 'SMTP test send',
    run: () => deploy.smtpSendTest('smtp.example.com', 587, 'user', 'password', 'test@example.com'),
    command: 'smtp_send_test',
    args: {
      host: 'smtp.example.com',
      port: 587,
      user: 'user',
      pass: 'password',
      toEmail: 'test@example.com',
    },
    result: false,
  },
  {
    name: 'Gmail test send',
    run: () =>
      deploy.gmailSendTest(
        'service@example.com',
        'synthetic-key',
        'from@example.com',
        'to@example.com',
      ),
    command: 'gmail_send_test',
    args: {
      serviceAccountEmail: 'service@example.com',
      privateKey: 'synthetic-key',
      fromEmail: 'from@example.com',
      toEmail: 'to@example.com',
    },
    result: { messageId: 'message-id', sentAt: '1' },
  },
  {
    name: 'secret generation',
    run: () => deploy.generateSecret(48),
    command: 'generate_secret',
    args: { length: 48 },
    result: 'native-generated-secret',
  },
  {
    name: 'encryption key generation',
    run: () => deploy.generateKek(),
    command: 'generate_kek',
    result: 'native-generated-key',
  },
  {
    name: 'RSA key generation',
    run: () => deploy.generateRsaKeypair(),
    command: 'generate_rsa_keypair',
    result: ['native-private-key', 'native-public-key'],
  },
  {
    name: 'HTTP response check',
    run: () => deploy.healthCheck('https://api.example.com/health/ready'),
    command: 'health_check',
    args: { url: 'https://api.example.com/health/ready' },
    result: 503,
  },
];

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  __resetDegradedModeForTests();
});
afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  __resetDegradedModeForTests();
});

describe('browser deployment boundary', () => {
  it.each(operations)('rejects $name before creating operational evidence', async ({ run }) => {
    await expect(run()).rejects.toThrow(
      /Demo mode cannot .*\. Run Studio to perform this operation\./,
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(isDegradedMode()).toBe(true);
  });
});

describe('native deployment bridge', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  });

  it.each(operations)('preserves $name command, arguments and returned result', async ({
    run,
    command,
    args,
    result,
  }) => {
    vi.mocked(invoke).mockResolvedValueOnce(result);
    await expect(run()).resolves.toEqual(result);
    if (args) expect(invoke).toHaveBeenCalledWith(command, args);
    else expect(invoke).toHaveBeenCalledWith(command);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(isDegradedMode()).toBe(false);
  });

  it.each(operations)('propagates $name failure without producing a substitute result', async ({
    run,
  }) => {
    const error = new Error('Native operation failed');
    vi.mocked(invoke).mockRejectedValueOnce(error);
    await expect(run()).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([200, 301])('preserves HTTP %s without upgrading its meaning', async (status) => {
    vi.mocked(invoke).mockResolvedValueOnce(status);
    await expect(deploy.healthCheck('https://api.example.com/health/live')).resolves.toBe(status);
    expect(invoke).toHaveBeenCalledWith('health_check', {
      url: 'https://api.example.com/health/live',
    });
  });
});
