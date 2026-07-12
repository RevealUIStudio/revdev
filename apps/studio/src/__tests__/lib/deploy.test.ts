import { describe, expect, it } from 'vitest';
import {
  generateKek,
  generateRsaKeypair,
  generateSecret,
  healthCheck,
  neonTestConnection,
  resendSendTest,
  runDbMigrate,
  runDbSeed,
  smtpSendTest,
  stripeCatalogSync,
  stripeRunKeys,
  stripeRunSeed,
  stripeValidateKeys,
  vercelCreateProject,
  vercelDeploy,
  vercelGetDeployment,
  vercelSetEnv,
  vercelValidateBlobToken,
  vercelValidateToken,
} from '../../lib/deploy';

describe('deploy bridge (browser mocks)', () => {
  // ── Vercel ────────────────────────────────────────────────────────────────

  it('vercelValidateToken returns empty array', async () => {
    expect(await vercelValidateToken('token')).toEqual([]);
  });

  it('vercelValidateBlobToken returns true', async () => {
    expect(await vercelValidateBlobToken('vercel_blob_token')).toBe(true);
  });

  it('vercelCreateProject returns mock project with accountId', async () => {
    const result = await vercelCreateProject('token', 'test', 'nextjs');
    expect(result).toEqual({
      id: 'mock-test',
      name: 'test',
      framework: 'nextjs',
      accountId: 'mock-team',
    });
  });

  it('vercelSetEnv resolves without error', async () => {
    await expect(vercelSetEnv('t', 'p', 'k', 'v')).resolves.toBeUndefined();
  });

  it('vercelDeploy returns an obviously-fake deploy id', async () => {
    expect(await vercelDeploy('t', 'p')).toBe('MOCK_DEPLOY_ID_DO_NOT_USE');
  });

  it('vercelGetDeployment returns READY state with deployment ID', async () => {
    const result = await vercelGetDeployment('t', 'dep-1');
    expect(result.state).toBe('READY');
    expect(result.uid).toBe('dep-1');
    expect(result.url).toBe('mock.vercel.app');
    expect(result.created).toBeTypeOf('bigint');
  });

  // ── Database ──────────────────────────────────────────────────────────────

  it('neonTestConnection returns mock timestamp string', async () => {
    const result = await neonTestConnection('postgres://...');
    expect(result).toBe('NOW() = 2026-03-15 (mock)');
  });

  it('runDbMigrate returns mock completion message', async () => {
    expect(await runDbMigrate('/repo')).toBe('Migrations complete (mock)');
  });

  it('runDbSeed returns mock completion message', async () => {
    expect(await runDbSeed('/repo')).toBe('Seed complete (mock)');
  });

  // ── Stripe ────────────────────────────────────────────────────────────────

  it('stripeValidateKeys returns true', async () => {
    expect(await stripeValidateKeys('sk_test')).toBe(true);
  });

  it('stripeRunSeed returns mock completion message', async () => {
    expect(await stripeRunSeed('/repo')).toBe('Stripe seed complete (mock)');
  });

  it('stripeRunKeys returns mock completion message', async () => {
    expect(await stripeRunKeys('/repo')).toBe('Keys generated (mock)');
  });

  it('stripeCatalogSync returns mock completion message', async () => {
    expect(await stripeCatalogSync('/repo')).toBe('Catalog synced (mock)');
  });

  // ── Email ─────────────────────────────────────────────────────────────────

  it('resendSendTest returns true', async () => {
    expect(await resendSendTest('key', 'test@example.com')).toBe(true);
  });

  it('smtpSendTest returns true', async () => {
    expect(await smtpSendTest('smtp.example.com', 587, 'user', 'pass', 'test@example.com')).toBe(
      true,
    );
  });

  // ── Secrets ───────────────────────────────────────────────────────────────

  it('generateSecret returns an obviously-fake secret of the requested length', async () => {
    const result = await generateSecret(48);
    expect(result).toHaveLength(48);
    // Must NOT look like a real secret — it should scream MOCK so it can't be
    // mistaken for or copied into a real env (see audit Theme 2).
    expect(result.startsWith('MOCK_SECRET')).toBe(true);
    expect(result).not.toBe('x'.repeat(48));
  });

  it('generateKek returns an obviously-fake 64-char value', async () => {
    const result = await generateKek();
    expect(result).toHaveLength(64);
    expect(result.startsWith('MOCK_KEK')).toBe(true);
    expect(result).not.toBe('a'.repeat(64));
  });

  it('generateRsaKeypair returns obviously-fake key sentinels', async () => {
    const [priv, pub] = await generateRsaKeypair();
    expect(priv).toBe('MOCK_PRIVATE_KEY_DO_NOT_USE');
    expect(pub).toBe('MOCK_PUBLIC_KEY_DO_NOT_USE');
  });

  // ── Health ────────────────────────────────────────────────────────────────

  it('healthCheck returns 200', async () => {
    expect(await healthCheck('https://example.com')).toBe(200);
  });
});
