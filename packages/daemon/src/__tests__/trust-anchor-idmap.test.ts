/**
 * GAP-409 item 2 (D7-D9): the trust-anchor root-owned check must accept
 * uid 65534 ONLY under the proven WSL systemd-user idmap squash (the same
 * predicate revdev#304 shipped for bwrap), and must stay fail-closed for
 * every other non-root owner.
 *
 * node:fs and node:fs/promises are fully mocked so uid scenarios that cannot
 * be fabricated as a non-root test user (root-owned trees, idmap-squashed
 * trees) are deterministic. confinement.ts touches the real fs only at call
 * time, so mocking here never races module init.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  /** uid reported for /usr/bin/true — 0 = no squash, 65534 = squash proven */
  systemProbeUid: 0,
  /** uid reported for every anchor ancestor dir and the anchor file */
  anchorUid: 0,
};

function dirStat(uid: number) {
  return {
    isSymbolicLink: () => false,
    isDirectory: () => true,
    uid,
    mode: 0o40755,
  };
}

function fileStat(uid: number) {
  return {
    isFile: () => true,
    uid,
    mode: 0o100644,
  };
}

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    statSync: vi.fn((p: unknown): { isFile: () => boolean; uid: number } => {
      if (p === '/usr/bin/true') {
        return { isFile: () => true, uid: state.systemProbeUid };
      }
      return real.statSync(p as string);
    }),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: vi.fn(async () => dirStat(state.anchorUid)),
    open: vi.fn(async () => ({
      stat: async () => fileStat(state.anchorUid),
      readFile: async () => 'agent-a:fp-a\n',
      close: async () => undefined,
    })),
  };
});

import { isTrustedRootOwner, readRootOwnedFile } from '../confinement.js';

beforeEach(() => {
  state.systemProbeUid = 0;
  state.anchorUid = 0;
});

describe('isTrustedRootOwner (GAP-409 D7)', () => {
  it('trusts uid 0 unconditionally', () => {
    state.systemProbeUid = 0;
    expect(isTrustedRootOwner({ uid: 0 })).toBe(true);
    state.systemProbeUid = 65534;
    expect(isTrustedRootOwner({ uid: 0 })).toBe(true);
  });

  it('trusts uid 65534 only when the system-wide squash is proven', () => {
    state.systemProbeUid = 65534;
    expect(isTrustedRootOwner({ uid: 65534 })).toBe(true);
    state.systemProbeUid = 0;
    expect(isTrustedRootOwner({ uid: 65534 })).toBe(false);
  });

  it('never trusts an ordinary user uid, squash or not (D8)', () => {
    state.systemProbeUid = 65534;
    expect(isTrustedRootOwner({ uid: 1000 })).toBe(false);
    state.systemProbeUid = 0;
    expect(isTrustedRootOwner({ uid: 1000 })).toBe(false);
  });
});

describe('readRootOwnedFile under idmap squash (GAP-409 D7-D9)', () => {
  it('reads a root-owned anchor (uid 0 everywhere) — the pre-existing path', async () => {
    state.anchorUid = 0;
    await expect(readRootOwnedFile('/etc/revdev/trusted-clients')).resolves.toBe('agent-a:fp-a\n');
  });

  it('reads a 65534-owned anchor when the squash is proven (the WSL systemd-user fix)', async () => {
    state.systemProbeUid = 65534;
    state.anchorUid = 65534;
    await expect(readRootOwnedFile('/etc/revdev/trusted-clients')).resolves.toBe('agent-a:fp-a\n');
  });

  it('rejects a 65534-owned anchor when the squash is NOT proven (fail-closed, D8)', async () => {
    state.systemProbeUid = 0;
    state.anchorUid = 65534;
    await expect(readRootOwnedFile('/etc/revdev/trusted-clients')).rejects.toThrow(
      'not root-owned',
    );
  });

  it('rejects a user-owned anchor even when the squash IS active (D8)', async () => {
    state.systemProbeUid = 65534;
    state.anchorUid = 1000;
    await expect(readRootOwnedFile('/etc/revdev/trusted-clients')).rejects.toThrow(
      'not root-owned',
    );
  });
});
