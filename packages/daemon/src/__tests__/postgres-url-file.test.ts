/**
 * POSTGRES_URL_FILE resolution (GAP-154 finish).
 * @vitest-environment node
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { _resetForTesting, resolvePostgresUrl } from '../neon.js';

describe('resolvePostgresUrl / POSTGRES_URL_FILE', () => {
  const prevUrl = process.env.POSTGRES_URL;
  const prevDb = process.env.DATABASE_URL;
  const prevFile = process.env.POSTGRES_URL_FILE;

  afterEach(() => {
    _resetForTesting();
    if (prevUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = prevUrl;
    if (prevDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDb;
    if (prevFile === undefined) delete process.env.POSTGRES_URL_FILE;
    else process.env.POSTGRES_URL_FILE = prevFile;
  });

  it('reads POSTGRES_URL_FILE when inline URL unset', async () => {
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    const dir = await mkdtemp(join(tmpdir(), 'pgurl-'));
    const file = join(dir, 'url');
    await writeFile(file, '  postgresql://user:pass@example.com/db  \n');
    process.env.POSTGRES_URL_FILE = file;
    expect(resolvePostgresUrl()).toBe('postgresql://user:pass@example.com/db');
    await rm(dir, { recursive: true, force: true });
  });

  it('prefers POSTGRES_URL over file', async () => {
    process.env.POSTGRES_URL = 'postgresql://inline/db';
    process.env.POSTGRES_URL_FILE = '/no/such/file';
    expect(resolvePostgresUrl()).toBe('postgresql://inline/db');
  });
});
