import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Simulate a corrupt / unloadable manifest: loadPatterns throws exactly as
// validateManifest would on a malformed patterns.json. initToolGuard() calls
// loadPatterns and is invoked by startDaemon BEFORE the socket binds, so the
// daemon must refuse to start (fail closed, mirroring initLicenseGuard).
vi.mock('../tool-guard/patterns.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tool-guard/patterns.js')>();
  return {
    ...actual,
    loadPatterns: () => {
      throw new Error('tool-guard patterns.json invalid: simulated corruption');
    },
  };
});

const { startDaemon } = await import('../server.js');

describe('daemon fail-closed on corrupt tool-guard manifest', () => {
  it('refuses to start when the manifest cannot load', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'revdev-tg-boot-'));
    const socketPath = join(dataDir, 'harness.sock');
    await expect(startDaemon({ socketPath, dataDir })).rejects.toThrow(/tool-guard/);
  });
});
