/**
 * Unit tests for resolveStaticPath containment (absolute URL paths must not
 * escape staticDir — Node's path.join replaces the base when given an abs path).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveStaticPath } from '../http-gateway.js';

describe('resolveStaticPath', () => {
  let staticDir: string;

  beforeEach(async () => {
    staticDir = await mkdtemp(join(tmpdir(), 'revdev-static-'));
    await writeFile(join(staticDir, 'index.html'), '<html></html>');
    await writeFile(join(staticDir, 'app.js'), 'console.log(1)');
  });

  afterEach(async () => {
    await rm(staticDir, { recursive: true, force: true });
  });

  it('serves files under staticDir', () => {
    const p = resolveStaticPath(staticDir, '/app.js');
    expect(p).toBe(resolve(staticDir, 'app.js'));
  });

  it('maps / and empty to index.html', () => {
    expect(resolveStaticPath(staticDir, '/')).toBe(resolve(staticDir, 'index.html'));
    expect(resolveStaticPath(staticDir, '')).toBe(resolve(staticDir, 'index.html'));
  });

  it('does not escape staticDir for absolute-looking URL paths', () => {
    // Historical bug: path.join(staticDir, '/etc/passwd') === '/etc/passwd'
    // After the fix, leading slashes are stripped so the path stays under staticDir
    // (or is rejected) — never the real OS /etc/passwd.
    const base = resolve(staticDir);
    for (const candidate of ['/etc/passwd', '////etc/passwd', '/etc/shadow']) {
      const p = resolveStaticPath(staticDir, candidate);
      expect(p).not.toBe(candidate);
      expect(p).not.toBe('/etc/passwd');
      expect(p).not.toBe('/etc/shadow');
      if (p !== null) {
        expect(p === base || p.startsWith(base + sep)).toBe(true);
      }
    }
  });

  it('rejects .. traversal segments', () => {
    expect(resolveStaticPath(staticDir, '/../etc/passwd')).toBeNull();
    expect(resolveStaticPath(staticDir, 'foo/../../etc/passwd')).toBeNull();
    expect(resolveStaticPath(staticDir, 'foo/../../../etc/passwd')).toBeNull();
  });

  it('rejects NUL bytes', () => {
    expect(resolveStaticPath(staticDir, 'app.js\0/etc/passwd')).toBeNull();
  });

  it('rejects empty staticDir', () => {
    expect(resolveStaticPath('', '/app.js')).toBeNull();
  });

  it('never returns a path outside the resolved static root', () => {
    const candidates = [
      '/etc/passwd',
      '/etc/shadow',
      '///var/log/syslog',
      '..',
      '../',
      '../../',
      'a/../../b',
      `${'../'.repeat(20)}etc/passwd`,
    ];
    const base = resolve(staticDir);
    for (const c of candidates) {
      const p = resolveStaticPath(staticDir, c);
      if (p !== null) {
        expect(p === base || p.startsWith(base + sep)).toBe(true);
      }
    }
  });
});
