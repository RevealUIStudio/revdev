import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = join(dirname(fileURLToPath(import.meta.url)), 'verify-copy-lockstep.sh');
const systemGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'revdev-lockstep-audit-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', '.revcon-manifest.json'),
    JSON.stringify({ mode: 'copy', profiles: [], files: {} }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function check(env = process.env) {
  return spawnSync('bash', [script, '--target', root], { encoding: 'utf8', env });
}

describe('copy lockstep tracked-file inventory', () => {
  it('fails when the target has no Git inventory', () => {
    const result = check();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cannot check tracked strays');
  });

  it('fails when Git cannot list tracked files', () => {
    expect(spawnSync(systemGit, ['init', '-q', root]).status).toBe(0);
    const fakebin = join(root, 'fakebin');
    mkdirSync(fakebin);
    writeFileSync(
      join(fakebin, 'git'),
      `#!/bin/sh\ncase " $* " in *" ls-files "*) exit 128;; esac\nexec "${systemGit}" "$@"\n`,
    );
    chmodSync(join(fakebin, 'git'), 0o755);
    const result = check({ ...process.env, PATH: `${fakebin}:${process.env.PATH}` });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('could not list');
  });

  it('rejects tracked files missing from the manifest', () => {
    expect(spawnSync(systemGit, ['init', '-q', root]).status).toBe(0);
    mkdirSync(join(root, '.claude', 'rules'));
    writeFileSync(join(root, '.claude', 'rules', 'extra.md'), 'tracked');
    expect(spawnSync(systemGit, ['-C', root, 'add', '.claude/rules/extra.md']).status).toBe(0);
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tracked but not in the manifest');
  });
});

describe('copy lockstep manifest parsing', () => {
  it.each([
    ['array file entry', '{"mode":"copy","profiles":[],"files":{"rules/example.md":[]}}'],
    [
      'missing digest',
      '{"mode":"copy","profiles":[],"files":{"rules/example.md":{"source":"profile"}}}',
    ],
    ['missing profiles', '{"mode":"copy","files":{}}'],
    [
      'control character in key',
      JSON.stringify({
        mode: 'copy',
        profiles: [],
        files: { 'rules/bad\nname.md': { source: 'profile', sha256: 'a'.repeat(64) } },
      }),
    ],
    [
      'traversal key',
      JSON.stringify({
        mode: 'copy',
        profiles: [],
        files: { 'rules/../escape.md': { source: 'profile', sha256: 'a'.repeat(64) } },
      }),
    ],
    ['empty document', ''],
    [
      'multiple documents',
      '{"mode":"copy","profiles":[],"files":{}}\n{"mode":"copy","profiles":[],"files":{}}',
    ],
  ])('rejects %s before inventory', (_label, manifest) => {
    writeFileSync(join(root, '.claude', '.revcon-manifest.json'), manifest);
    expect(spawnSync(systemGit, ['init', '-q', root]).status).toBe(0);
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not one valid copy manifest');
    expect(result.stdout).not.toContain('copy-lockstep:');
  });

  it('preserves quotes and backslashes in manifest paths and hashes their bytes', () => {
    expect(spawnSync(systemGit, ['init', '-q', root]).status).toBe(0);
    const rel = 'rules/quote"and\\backslash.md';
    const source = 'profiles/quote"and\\backslash.md';
    const content = 'matching content';
    mkdirSync(join(root, '.claude', 'rules'));
    writeFileSync(join(root, '.claude', rel), content);
    writeFileSync(
      join(root, '.claude', '.revcon-manifest.json'),
      JSON.stringify({
        mode: 'copy',
        profiles: ['synthetic'],
        files: { [rel]: { source, sha256: createHash('sha256').update(content).digest('hex') } },
      }),
    );
    expect(spawnSync(systemGit, ['-C', root, 'add', `.claude/${rel}`]).status).toBe(0);
    const result = check();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 materialized file(s) match');
    expect(result.stdout).toContain('profiles: synthetic');
  });
});
