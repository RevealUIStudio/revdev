/**
 * Tests for vcs.ts runChild — timeout + abort + shutdown propagation.
 *
 * runChild is the testable core under runGit; we exercise it via `node -e`
 * commands so the tests are self-contained (no git binary needed beyond
 * what already runs in CI) and deterministic.
 */

import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { runChild } from '../vcs.js';

vi.setConfig({ testTimeout: 10_000, hookTimeout: 10_000 });

const NODE = process.execPath;
const CWD = tmpdir();

describe('runChild', () => {
  it('returns ok:true with stdout for a successful child', async () => {
    const result = await runChild(NODE, ['-e', 'process.stdout.write("hello")'], {
      cwd: CWD,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('hello');
    expect(result.code).toBe(0);
    expect(result.aborted).toBeUndefined();
  });

  it('returns ok:false with non-zero exit code for a failing child', async () => {
    const result = await runChild(NODE, ['-e', 'process.exit(7)'], {
      cwd: CWD,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(7);
    expect(result.aborted).toBeUndefined();
  });

  it('SIGTERMs and reports abortReason="timeout" when the child exceeds timeoutMs', async () => {
    // setInterval keeps the process alive; only an external signal can
    // bring it down.
    const result = await runChild(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: CWD,
      timeoutMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe('timeout');
    expect(result.stderr).toContain('timed out after 100ms');
  });

  it('SIGTERMs and reports abortReason="shutdown" when the externalSignal aborts', async () => {
    const ctrl = new AbortController();
    // Abort 50ms after spawn — give the child time to start up.
    setTimeout(() => ctrl.abort(), 50);
    const result = await runChild(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: CWD,
      timeoutMs: 5_000,
      externalSignal: ctrl.signal,
    });
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe('shutdown');
    expect(result.stderr).toContain('aborted by daemon shutdown');
  });

  it('treats a pre-aborted externalSignal as immediate shutdown abort', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await runChild(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: CWD,
      timeoutMs: 5_000,
      externalSignal: ctrl.signal,
    });
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe('shutdown');
  });

  it('returns ok:false with stderr.message for a non-existent command', async () => {
    const result = await runChild('/nonexistent-binary-revdev-test', [], {
      cwd: CWD,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.aborted).toBeUndefined();
    expect(result.code).toBe(-1);
    // The exact error message varies (ENOENT on Linux, etc.) — just
    // confirm we got an error string back rather than crashing.
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('captures stderr from a child that prints to stderr and exits non-zero', async () => {
    const result = await runChild(NODE, ['-e', 'process.stderr.write("oops"); process.exit(1)'], {
      cwd: CWD,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('oops');
    expect(result.aborted).toBeUndefined();
  });

  it('honors timeout precedence over external signal when timeout fires first', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5_000); // would-be later abort
    const result = await runChild(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: CWD,
      timeoutMs: 100,
      externalSignal: ctrl.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe('timeout');
  });
});
