/**
 * GAP-309 — format enforcement unit tests.
 *
 * Prove: repo-declared biome/cargo check-and-reject, no hardcoded paths,
 * exempt paths skip, undeclared repos pass through.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  _isFormatExemptPathForTest,
  assertFormattedContent,
  FORMAT_REJECTED_CODE,
  FormatRejectedError,
} from '../format-enforce.js';
import { detectDeclaredFormatter, resolveLocalBin } from '../repo-tooling.js';

// Locate the worktree's biome binary so tests do not depend on a global install.
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = join(here, '..', '..', '..', '..');
const biomeBinDir = join(monorepoRoot, 'node_modules', '.bin');

const MINIMAL_BIOME_JSON = `{
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineEnding": "lf"
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "always"
    }
  }
}
`;

describe('repo-tooling detection', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'revdev-tooling-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns null when no formatter is declared', async () => {
    await writeFile(join(root, 'a.ts'), 'x');
    expect(await detectDeclaredFormatter(root, join(root, 'a.ts'))).toBeNull();
  });

  it('finds biome.json by walking up within the root', async () => {
    await writeFile(join(root, 'biome.json'), MINIMAL_BIOME_JSON);
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    const file = join(root, 'src', 'nested', 'a.ts');
    await writeFile(file, 'x');
    const found = await detectDeclaredFormatter(root, file);
    expect(found).toEqual({
      root,
      formatter: 'biome',
      configPath: join(root, 'biome.json'),
    });
  });

  it('finds Cargo.toml for rust trees', async () => {
    await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "t"\nversion = "0.1.0"\n');
    await mkdir(join(root, 'src'));
    const file = join(root, 'src', 'lib.rs');
    await writeFile(file, 'x');
    const found = await detectDeclaredFormatter(root, file);
    expect(found?.formatter).toBe('cargo');
    expect(found?.root).toBe(root);
  });

  it('resolves local node_modules/.bin/biome when present', async () => {
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
    const bin = join(root, 'node_modules', '.bin', 'biome');
    await writeFile(bin, '#!/bin/sh\necho stub\n', { mode: 0o755 });
    expect(await resolveLocalBin(root, root, 'biome')).toBe(bin);
  });

  it('marks generated path segments as exempt', () => {
    expect(_isFormatExemptPathForTest('/proj/node_modules/pkg/x.ts')).toBe(true);
    expect(_isFormatExemptPathForTest('/proj/dist/out.js')).toBe(true);
    expect(_isFormatExemptPathForTest('/proj/src/a.ts')).toBe(false);
  });
});

describe('assertFormattedContent (biome check-and-reject)', () => {
  let root: string;
  let prevPath: string | undefined;

  beforeAll(() => {
    // Prefer the monorepo biome so fixtures only need a biome.json.
    prevPath = process.env.PATH;
    process.env.PATH = `${biomeBinDir}:${process.env.PATH ?? ''}`;
  });

  afterAll(() => {
    process.env.PATH = prevPath;
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'revdev-fmt-'));
    await writeFile(join(root, 'biome.json'), MINIMAL_BIOME_JSON);
  });

  it('rejects unformatted TypeScript content with -32007 and a fix command', async () => {
    const abs = join(root, 'src', 'bad.ts');
    await mkdir(dirname(abs), { recursive: true });
    await expect(
      assertFormattedContent({
        repoReal: root,
        absFile: abs,
        content: 'const  x =1',
      }),
    ).rejects.toMatchObject({
      name: 'FormatRejectedError',
      code: FORMAT_REJECTED_CODE,
      data: {
        kind: 'format-rejected',
        formatter: 'biome',
      },
    });

    try {
      await assertFormattedContent({
        repoReal: root,
        absFile: abs,
        content: 'const  x =1',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FormatRejectedError);
      const e = err as FormatRejectedError;
      expect(e.message).toContain('biome');
      expect(e.data.fixCommand).toContain('biome check --write');
      expect(e.data.filePath).toBe('src/bad.ts');
    }
  });

  it('accepts already-formatted TypeScript content', async () => {
    // Derive the exact formatted form from the same biome the daemon uses.
    const formatted = execFileSync(
      join(biomeBinDir, 'biome'),
      ['format', '--stdin-file-path', 'src/ok.ts'],
      {
        cwd: root,
        input: 'const x = 1\n',
        encoding: 'utf8',
      },
    );
    const abs = join(root, 'src', 'ok.ts');
    await mkdir(dirname(abs), { recursive: true });
    await expect(
      assertFormattedContent({
        repoReal: root,
        absFile: abs,
        content: formatted,
      }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when the repo declares no formatter', async () => {
    await rm(join(root, 'biome.json'));
    await expect(
      assertFormattedContent({
        repoReal: root,
        absFile: join(root, 'x.ts'),
        content: 'const  x =1',
      }),
    ).resolves.toBeUndefined();
  });

  it('skips non-biome extensions even when biome.json is present', async () => {
    await expect(
      assertFormattedContent({
        repoReal: root,
        absFile: join(root, 'notes.md'),
        content: '# title\n\n  messy   spaces',
      }),
    ).resolves.toBeUndefined();
  });

  it('skips node_modules paths', async () => {
    const abs = join(root, 'node_modules', 'pkg', 'index.ts');
    await expect(
      assertFormattedContent({
        repoReal: root,
        absFile: abs,
        content: 'const  x =1',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('assertFormattedContent (cargo check-and-reject)', () => {
  let root: string;
  let cargoAvailable = false;

  beforeAll(() => {
    try {
      execFileSync('cargo', ['--version'], { stdio: 'pipe' });
      cargoAvailable = true;
    } catch {
      cargoAvailable = false;
    }
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('rejects unformatted Rust when Cargo.toml is present', async () => {
    if (!cargoAvailable) return;

    root = await mkdtemp(join(tmpdir(), 'revdev-cargo-fmt-'));
    execFileSync('cargo', ['init', '-q', '--name', 'fmtcheck'], { cwd: root });
    const abs = join(root, 'src', 'main.rs');
    await expect(
      assertFormattedContent({
        repoReal: root,
        absFile: abs,
        content: 'fn main(){println!("hi");}\n',
      }),
    ).rejects.toMatchObject({
      name: 'FormatRejectedError',
      code: FORMAT_REJECTED_CODE,
      data: { formatter: 'cargo' },
    });
  });

  it('accepts rustfmt-clean content', async () => {
    if (!cargoAvailable) return;

    root = await mkdtemp(join(tmpdir(), 'revdev-cargo-fmt-ok-'));
    execFileSync('cargo', ['init', '-q', '--name', 'fmtok'], { cwd: root });
    const abs = join(root, 'src', 'main.rs');
    // Write then cargo fmt to get canonical form, then assert that form passes.
    await writeFile(abs, 'fn main() {\n    println!("hi");\n}\n');
    execFileSync('cargo', ['fmt', '--', 'src/main.rs'], { cwd: root });
    const clean = await readFile(abs, 'utf8');
    await expect(
      assertFormattedContent({
        repoReal: root,
        absFile: abs,
        content: clean,
      }),
    ).resolves.toBeUndefined();
  });

  it('does not enforce cargo fmt on non-.rs files', async () => {
    root = await mkdtemp(join(tmpdir(), 'revdev-cargo-skip-'));
    await writeFile(
      join(root, 'Cargo.toml'),
      '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    await expect(
      assertFormattedContent({
        repoReal: root,
        absFile: join(root, 'README.md'),
        content: 'messy',
      }),
    ).resolves.toBeUndefined();
  });
});
