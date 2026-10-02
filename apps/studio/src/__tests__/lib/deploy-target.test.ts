import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runDbMigrate, runDbSeed } from '../../lib/deploy';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue('done') }));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
});

afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

it('passes the selected database to both native mutation commands', async () => {
  const connectionString = 'postgresql://selected.invalid/chosen';
  await runDbMigrate('/workspace/revealui', connectionString);
  await runDbSeed('/workspace/revealui', connectionString);
  expect(invoke).toHaveBeenNthCalledWith(1, 'run_db_migrate', {
    repoPath: '/workspace/revealui',
    connectionString,
  });
  expect(invoke).toHaveBeenNthCalledWith(2, 'run_db_seed', {
    repoPath: '/workspace/revealui',
    connectionString,
  });
});
