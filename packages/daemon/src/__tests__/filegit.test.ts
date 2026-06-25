/**
 * Path-containment unit tests for the file.* / git.* surface (ADR zero-9P P0).
 *
 * These cover the third security barrier in isolation — the registered-root
 * allowlist + realpath descendant check — without standing up a daemon or
 * signing envelopes (the signed-RPC round-trip tests live in P5). The point
 * is that neither a `..` traversal nor a symlink can escape a registered
 * project root to reach `~/.ssh`, `~/.age-identity`, etc.
 */

import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _addRootForTest,
  _clearRegisteredRootsForTest,
  _gitRelPathForTest,
  _resolveInRootForTest,
} from '../filegit.js';

describe('filegit path containment', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    _clearRegisteredRootsForTest();
    // realpath so macOS /var -> /private/var symlink doesn't break `within`.
    root = await realpath(await mkdtemp(join(tmpdir(), 'revdev-root-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'revdev-out-')));
    _addRootForTest(root);
  });

  afterEach(() => {
    _clearRegisteredRootsForTest();
  });

  describe('resolveInRoot (realpath descendant check)', () => {
    it('resolves an existing file inside the root', async () => {
      await writeFile(join(root, 'a.txt'), 'hi');
      const resolved = await _resolveInRootForTest(root, 'a.txt', true);
      expect(resolved).toBe(join(root, 'a.txt'));
    });

    it('resolves a new file in an existing subdir (mustExist=false)', async () => {
      await mkdir(join(root, 'sub'));
      const resolved = await _resolveInRootForTest(root, 'sub/new.txt', false);
      expect(resolved).toBe(join(root, 'sub', 'new.txt'));
    });

    it('rejects a ../ traversal escape', async () => {
      await expect(_resolveInRootForTest(root, '../escape.txt', false)).rejects.toThrow(
        'escapes project root',
      );
    });

    it('rejects an absolute path outside the root', async () => {
      await writeFile(join(outside, 'secret'), 'x');
      await expect(_resolveInRootForTest(root, join(outside, 'secret'), true)).rejects.toThrow(
        'escapes project root',
      );
    });

    it('rejects a symlink that points outside the root', async () => {
      await writeFile(join(outside, 'secret'), 'x');
      await symlink(join(outside, 'secret'), join(root, 'link'));
      // realpath resolves the link to its outside target → escape.
      await expect(_resolveInRootForTest(root, 'link', true)).rejects.toThrow(
        'escapes project root',
      );
    });

    it('rejects a path whose parent escapes via symlinked dir', async () => {
      await symlink(outside, join(root, 'linkdir'));
      await expect(_resolveInRootForTest(root, 'linkdir/file.txt', false)).rejects.toThrow(
        'escapes project root',
      );
    });
  });

  describe('gitRelPath (lexical pathspec check)', () => {
    it('returns a clean repo-relative path', () => {
      expect(_gitRelPathForTest(root, 'src/x.ts')).toBe(join('src', 'x.ts'));
    });

    it('rejects ../ escape', () => {
      expect(() => _gitRelPathForTest(root, '../x.ts')).toThrow('escapes project root');
    });

    it('rejects an absolute path outside the root', () => {
      expect(() => _gitRelPathForTest(root, join(outside, 'x.ts'))).toThrow('escapes project root');
    });

    it('rejects the repo root itself as a pathspec', () => {
      expect(() => _gitRelPathForTest(root, '.')).toThrow('escapes project root');
    });
  });
});
