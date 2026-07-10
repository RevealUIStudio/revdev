import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { VercelDeployment, VercelProject } from '../types';
import { markDegraded } from './degraded-mode';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ── Vercel ─────────────────────────────────────────────────────────────────

export async function vercelValidateToken(token: string): Promise<VercelProject[]> {
  if (!isTauri()) return [];
  return tauriInvoke<VercelProject[]>('vercel_validate_token', { token });
}

export async function vercelValidateBlobToken(token: string): Promise<boolean> {
  if (!isTauri()) return true;
  return tauriInvoke<boolean>('vercel_validate_blob_token', { token });
}

export async function vercelCreateProject(
  token: string,
  name: string,
  framework: string,
  rootDirectory?: string,
): Promise<VercelProject> {
  if (!isTauri()) return { id: `mock-${name}`, name, framework, accountId: 'mock-team' };
  return tauriInvoke<VercelProject>('vercel_create_project', {
    token,
    name,
    framework,
    rootDirectory: rootDirectory ?? null,
  });
}

export async function vercelSetEnv(
  token: string,
  projectId: string,
  key: string,
  value: string,
  target: string[] = ['production', 'preview', 'development'],
): Promise<void> {
  if (!isTauri()) return;
  return tauriInvoke<void>('vercel_set_env', { token, projectId, key, value, target });
}

export async function vercelDeploy(token: string, projectId: string): Promise<string> {
  if (!isTauri()) {
    markDegraded('Demo mode. No deployment actually ran, this deploy id is a fake placeholder.');
    return 'MOCK_DEPLOY_ID_DO_NOT_USE';
  }
  return tauriInvoke<string>('vercel_deploy', { token, projectId });
}

export async function vercelGetDeployment(
  token: string,
  deploymentId: string,
): Promise<VercelDeployment> {
  if (!isTauri()) {
    markDegraded('Demo mode. This deployment status is fake, nothing is actually live.');
    return {
      uid: deploymentId,
      url: 'mock.vercel.app',
      state: 'READY',
      created: BigInt(Date.now()),
    };
  }
  return tauriInvoke<VercelDeployment>('vercel_get_deployment', { token, deploymentId });
}

// ── Database ───────────────────────────────────────────────────────────────

export async function neonTestConnection(connectionString: string): Promise<string> {
  if (!isTauri()) return 'NOW() = 2026-03-15 (mock)';
  return tauriInvoke<string>('neon_test_connection', { connectionString });
}

export async function runDbMigrate(repoPath: string): Promise<string> {
  if (!isTauri()) return 'Migrations complete (mock)';
  return tauriInvoke<string>('run_db_migrate', { repoPath });
}

export async function runDbSeed(repoPath: string): Promise<string> {
  if (!isTauri()) return 'Seed complete (mock)';
  return tauriInvoke<string>('run_db_seed', { repoPath });
}

// ── Stripe ─────────────────────────────────────────────────────────────────

export async function stripeValidateKeys(secretKey: string): Promise<boolean> {
  if (!isTauri()) return true;
  return tauriInvoke<boolean>('stripe_validate_keys', { secretKey });
}

export async function stripeRunSeed(repoPath: string): Promise<string> {
  if (!isTauri()) return 'Stripe seed complete (mock)';
  return tauriInvoke<string>('stripe_run_seed', { repoPath });
}

export async function stripeRunKeys(repoPath: string): Promise<string> {
  if (!isTauri()) return 'Keys generated (mock)';
  return tauriInvoke<string>('stripe_run_keys', { repoPath });
}

export async function stripeCatalogSync(repoPath: string): Promise<string> {
  if (!isTauri()) return 'Catalog synced (mock)';
  return tauriInvoke<string>('stripe_catalog_sync', { repoPath });
}

// ── Email ──────────────────────────────────────────────────────────────────

export async function resendSendTest(apiKey: string, toEmail: string): Promise<boolean> {
  if (!isTauri()) return true;
  return tauriInvoke<boolean>('resend_send_test', { apiKey, toEmail });
}

export async function smtpSendTest(
  host: string,
  port: number,
  user: string,
  pass: string,
  toEmail: string,
): Promise<boolean> {
  if (!isTauri()) return true;
  return tauriInvoke<boolean>('smtp_send_test', { host, port, user, pass, toEmail });
}

// ── Secrets ────────────────────────────────────────────────────────────────

/**
 * An obviously-fake secret of the requested length. Browser mode has no real
 * crypto backend; the previous mocks (`'x'.repeat(n)`, `'a'.repeat(64)`)
 * looked like real secrets and could be copied into a real env. This screams
 * MOCK while keeping the length the UI expects.
 */
function mockSecret(label: string, length: number): string {
  const marker = `MOCK_${label}_DO_NOT_USE_`;
  return marker.repeat(Math.ceil(Math.max(length, marker.length) / marker.length)).slice(0, length);
}

export async function generateSecret(length: number): Promise<string> {
  if (!isTauri()) {
    markDegraded('Demo mode — generated secrets are fake placeholders, not real keys.');
    return mockSecret('SECRET', length);
  }
  return tauriInvoke<string>('generate_secret', { length });
}

export async function generateKek(): Promise<string> {
  if (!isTauri()) {
    markDegraded('Demo mode — generated secrets are fake placeholders, not real keys.');
    return mockSecret('KEK', 64);
  }
  return tauriInvoke<string>('generate_kek');
}

export async function generateRsaKeypair(): Promise<[string, string]> {
  if (!isTauri()) {
    markDegraded('Demo mode — generated secrets are fake placeholders, not real keys.');
    return ['MOCK_PRIVATE_KEY_DO_NOT_USE', 'MOCK_PUBLIC_KEY_DO_NOT_USE'];
  }
  return tauriInvoke<[string, string]>('generate_rsa_keypair');
}

// ── Health ──────────────────────────────────────────────────────────────────

export async function healthCheck(url: string): Promise<number> {
  if (!isTauri()) return 200;
  return tauriInvoke<number>('health_check', { url });
}
