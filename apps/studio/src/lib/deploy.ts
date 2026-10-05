import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { VercelDeployment, VercelProject } from '../types';
import { markDegraded } from './degraded-mode';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function requireTauri(operation: string): void {
  if (isTauri()) return;
  markDegraded('Demo mode. No deployment operation was performed.');
  throw new Error(`Demo mode cannot ${operation}. Run Studio to perform this operation.`);
}

// ── Vercel ─────────────────────────────────────────────────────────────────

export async function vercelValidateToken(token: string): Promise<VercelProject[]> {
  requireTauri('validate a Vercel token');
  return tauriInvoke<VercelProject[]>('vercel_validate_token', { token });
}

export async function vercelValidateBlobToken(token: string): Promise<boolean> {
  requireTauri('validate a blob token');
  return tauriInvoke<boolean>('vercel_validate_blob_token', { token });
}

export async function vercelCreateProject(
  token: string,
  name: string,
  framework: string,
  rootDirectory?: string,
): Promise<VercelProject> {
  requireTauri('create a Vercel project');
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
  requireTauri('set deployment environment variables');
  return tauriInvoke<void>('vercel_set_env', { token, projectId, key, value, target });
}

export async function vercelDeploy(token: string, projectId: string): Promise<string> {
  requireTauri('deploy a Vercel project');
  return tauriInvoke<string>('vercel_deploy', { token, projectId });
}

export async function vercelGetDeployment(
  token: string,
  deploymentId: string,
): Promise<VercelDeployment> {
  requireTauri('read deployment status');
  return tauriInvoke<VercelDeployment>('vercel_get_deployment', { token, deploymentId });
}

// ── Database ───────────────────────────────────────────────────────────────

export async function neonTestConnection(connectionString: string): Promise<string> {
  requireTauri('test a database connection');
  return tauriInvoke<string>('neon_test_connection', { connectionString });
}

export async function runDbMigrate(repoPath: string, connectionString: string): Promise<string> {
  requireTauri('run database migrations');
  return tauriInvoke<string>('run_db_migrate', { repoPath, connectionString });
}

export async function runDbSeed(repoPath: string, connectionString: string): Promise<string> {
  requireTauri('seed a database');
  return tauriInvoke<string>('run_db_seed', { repoPath, connectionString });
}

// ── Stripe ─────────────────────────────────────────────────────────────────

export async function stripeValidateKeys(secretKey: string): Promise<boolean> {
  requireTauri('validate Stripe keys');
  return tauriInvoke<boolean>('stripe_validate_keys', { secretKey });
}

export async function stripeRunSeed(repoPath: string): Promise<string> {
  requireTauri('seed Stripe products');
  return tauriInvoke<string>('stripe_run_seed', { repoPath });
}

export async function stripeRunKeys(repoPath: string): Promise<string> {
  requireTauri('generate Stripe keys');
  return tauriInvoke<string>('stripe_run_keys', { repoPath });
}

export async function stripeCatalogSync(repoPath: string): Promise<string> {
  requireTauri('sync the Stripe catalog');
  return tauriInvoke<string>('stripe_catalog_sync', { repoPath });
}

// ── Email ──────────────────────────────────────────────────────────────────

export async function resendSendTest(apiKey: string, toEmail: string): Promise<boolean> {
  requireTauri('send a Resend test email');
  return tauriInvoke<boolean>('resend_send_test', { apiKey, toEmail });
}

export async function smtpSendTest(
  host: string,
  port: number,
  user: string,
  pass: string,
  toEmail: string,
): Promise<boolean> {
  requireTauri('send an SMTP test email');
  return tauriInvoke<boolean>('smtp_send_test', { host, port, user, pass, toEmail });
}

export async function gmailSendTest(
  serviceAccountEmail: string,
  privateKey: string,
  fromEmail: string,
  toEmail: string,
): Promise<{ messageId: string; sentAt: string }> {
  requireTauri('send a real Gmail test');
  return tauriInvoke<{ messageId: string; sentAt: string }>('gmail_send_test', {
    serviceAccountEmail,
    privateKey,
    fromEmail,
    toEmail,
  });
}

// ── Secrets ────────────────────────────────────────────────────────────────

export async function generateSecret(length: number): Promise<string> {
  requireTauri('generate a deployment secret');
  return tauriInvoke<string>('generate_secret', { length });
}

export async function generateKek(): Promise<string> {
  requireTauri('generate an encryption key');
  return tauriInvoke<string>('generate_kek');
}

export async function generateRsaKeypair(): Promise<[string, string]> {
  requireTauri('generate an RSA key pair');
  return tauriInvoke<[string, string]>('generate_rsa_keypair');
}

// ── Health ──────────────────────────────────────────────────────────────────

export async function healthCheck(url: string): Promise<number> {
  requireTauri('check deployment responses');
  return tauriInvoke<number>('health_check', { url });
}
