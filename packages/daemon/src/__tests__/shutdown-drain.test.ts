/**
 * Tests for graceful-shutdown drain — server.close() waits for in-flight
 * RPC handlers before tearing down PGlite + the Unix socket.
 *
 * Two layers:
 *  - Direct exercise of the drain helper (`_drainActiveHandlersForTest`)
 *    using the test-only counter setter (`_setActiveHandlerCountForTest`).
 *    Deterministic; no daemon, no socket.
 *  - One end-to-end sanity test that exercises a real startDaemon →
 *    close() cycle with no in-flight handlers (drain returns immediately).
 *    Confirms the close()-side wiring doesn't regress.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _drainActiveHandlersForTest,
  _setActiveHandlerCountForTest,
  startDaemon,
} from '../server.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('drainActiveHandlers (helper)', () => {
  beforeEach(() => {
    _setActiveHandlerCountForTest(0);
  });

  afterEach(() => {
    _setActiveHandlerCountForTest(0);
  });

  it('returns drained:true immediately when no handlers are in flight', async () => {
    const start = Date.now();
    const result = await _drainActiveHandlersForTest(1000);
    const elapsed = Date.now() - start;
    expect(result.drained).toBe(true);
    expect(result.remaining).toBe(0);
    // Should resolve well under the deadline — first poll observes count=0.
    expect(elapsed).toBeLessThan(50);
  });

  it('waits while count > 0 and resolves when it drops to zero', async () => {
    _setActiveHandlerCountForTest(2);
    // Decrement asynchronously so the drain has to poll.
    setTimeout(() => _setActiveHandlerCountForTest(1), 30);
    setTimeout(() => _setActiveHandlerCountForTest(0), 60);

    const start = Date.now();
    const result = await _drainActiveHandlersForTest(1000);
    const elapsed = Date.now() - start;

    expect(result.drained).toBe(true);
    expect(result.remaining).toBe(0);
    // Should finish near the second decrement (~60 ms) not near the deadline.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(500);
  });

  it('returns drained:false with remaining count when deadline expires', async () => {
    _setActiveHandlerCountForTest(3);
    const start = Date.now();
    const result = await _drainActiveHandlersForTest(80);
    const elapsed = Date.now() - start;

    expect(result.drained).toBe(false);
    expect(result.remaining).toBe(3);
    // Deadline-bounded — should not significantly overshoot.
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(300);
  });

  it('handles fractional decrement progress that still misses the deadline', async () => {
    _setActiveHandlerCountForTest(5);
    // Drop to 2 inside the window; deadline still fires before reaching 0.
    setTimeout(() => _setActiveHandlerCountForTest(2), 30);

    const result = await _drainActiveHandlersForTest(80);
    expect(result.drained).toBe(false);
    expect(result.remaining).toBe(2);
  });

  it('respects a custom tick interval (slower polls still resolve)', async () => {
    _setActiveHandlerCountForTest(1);
    setTimeout(() => _setActiveHandlerCountForTest(0), 50);

    const result = await _drainActiveHandlersForTest(1000, 25);
    expect(result.drained).toBe(true);
  });
});

describe('startDaemon().close() — drain integration', () => {
  let dataDir: string;
  let socketPath: string;
  let originalLicenseKey: string | undefined;
  let originalPublicKey: string | undefined;

  beforeEach(async () => {
    const { generateTestLicense, setTestLicenseEnv } = await import('./test-license-helper.js');
    originalLicenseKey = process.env.REVEALUI_LICENSE_KEY;
    originalPublicKey = process.env.REVDEV_LICENSE_PUBLIC_KEY;
    setTestLicenseEnv(generateTestLicense('enterprise'));
    dataDir = await mkdtemp(join(tmpdir(), 'revdev-drain-'));
    socketPath = join(dataDir, 'harness.sock');
    _setActiveHandlerCountForTest(0);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    _setActiveHandlerCountForTest(0);
    const { clearTestLicenseEnv } = await import('./test-license-helper.js');
    clearTestLicenseEnv();
    if (originalLicenseKey) process.env.REVEALUI_LICENSE_KEY = originalLicenseKey;
    if (originalPublicKey) process.env.REVDEV_LICENSE_PUBLIC_KEY = originalPublicKey;
  });

  it('completes promptly when no handlers are in flight', async () => {
    const d = await startDaemon({ socketPath, dataDir, shutdownGracePeriodMs: 1000 });
    const start = Date.now();
    await d.close();
    const elapsed = Date.now() - start;
    // No handlers in flight — drain should resolve on the first poll.
    // Most of the elapsed time is db.close() + unlink, not the drain.
    expect(elapsed).toBeLessThan(2000);
  });

  it('does not exceed the configured grace period when a stuck handler is simulated', async () => {
    const d = await startDaemon({ socketPath, dataDir, shutdownGracePeriodMs: 100 });
    // Simulate a stuck handler by bumping the counter directly. close()'s
    // drain should hit the deadline, log a warning, and proceed.
    _setActiveHandlerCountForTest(1);
    const start = Date.now();
    await d.close();
    const elapsed = Date.now() - start;
    // Should pass the 100 ms drain deadline plus db.close() + unlink time,
    // but shouldn't hang indefinitely.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(3000);
    // Counter is still 1 (we never decremented it from the test side).
    // Reset for afterEach.
    _setActiveHandlerCountForTest(0);
  });
});
