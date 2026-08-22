import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockOpen, mockLaunchAllowedProgram } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockLaunchAllowedProgram: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: mockOpen,
}));

vi.mock('../../lib/invoke', () => ({
  launchAllowedProgram: mockLaunchAllowedProgram,
  detectBrowserProfiles: vi.fn(),
}));

import { launchTile, type TileDefinition } from '../../lib/tiles';

describe('launchTile', () => {
  beforeEach(() => {
    mockOpen.mockReset();
    mockLaunchAllowedProgram.mockReset();
    mockLaunchAllowedProgram.mockResolvedValue(undefined);
  });

  it('opens URL tiles through the scoped shell plugin', async () => {
    const tile: TileDefinition = {
      id: 'github',
      label: 'GitHub',
      category: 'accounts',
      action: { type: 'url', url: 'https://github.com/RevealUIStudio' },
    };

    await launchTile(tile);

    expect(mockOpen).toHaveBeenCalledWith('https://github.com/RevealUIStudio');
    expect(mockLaunchAllowedProgram).not.toHaveBeenCalled();
  });

  it('does not pass a free-form program path to the shell plugin', async () => {
    const tile: TileDefinition = {
      id: 'zed',
      label: 'Zed',
      category: 'editor',
      action: { type: 'shell', program: 'zed', args: ['.'] },
    };

    await launchTile(tile);

    expect(mockLaunchAllowedProgram).toHaveBeenCalledWith('zed', ['.']);
    expect(mockOpen).not.toHaveBeenCalled();
  });
});

describe('Studio Tauri shell capabilities', () => {
  it('does not grant unscoped shell execute or unscoped open', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '../../../src-tauri/capabilities/default.json'), 'utf8');
    const cap = JSON.parse(raw) as { permissions: unknown[] };
    const perms = cap.permissions.map((p) => (typeof p === 'string' ? p : JSON.stringify(p)));

    expect(perms).not.toContain('shell:allow-execute');
    expect(perms).not.toContain('shell:allow-spawn');
    expect(perms).not.toContain('shell:allow-open');
    expect(perms).toContain('shell:default');
  });
});
