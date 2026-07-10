/**
 * Unit tests for the confinement module (confinement.ts) — pure argv/env/backend
 * logic, no real spawn and no socket. The real-bwrap adversarial reads live in
 * confinement-integration.test.ts.
 *
 * @vitest-environment node
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildConfinedEnv,
  ensureAgentHome,
  filterCallerEnv,
  linuxBubblewrapBackend,
  resolveBwrapAbsPath,
  resolveConfinementBackend,
} from '../confinement.js';

// ---------------------------------------------------------------------------
// filterCallerEnv — the allow-list (spec §7, §10 test 3)
// ---------------------------------------------------------------------------

describe('filterCallerEnv', () => {
  it('accepts the exact allow-list keys', () => {
    const out = filterCallerEnv({ TERM: 'xterm', LANG: 'en_US.UTF-8', CI: '1', NO_COLOR: '1' });
    expect(out).toEqual({ TERM: 'xterm', LANG: 'en_US.UTF-8', CI: '1', NO_COLOR: '1' });
  });

  it('accepts the namespaced prefixes (LC_*, REVDEV_*)', () => {
    const out = filterCallerEnv({ LC_ALL: 'C', LC_TIME: 'C', REVDEV_FOO: 'bar' });
    expect(out).toEqual({ LC_ALL: 'C', LC_TIME: 'C', REVDEV_FOO: 'bar' });
  });

  it('rejects HOME by name (the escape the tmpfs would otherwise absorb)', () => {
    expect(() => filterCallerEnv({ HOME: '/home/op' })).toThrow(/"HOME" is not caller-settable/);
  });

  it('rejects PATH', () => {
    expect(() => filterCallerEnv({ PATH: '/evil/bin' })).toThrow(/"PATH" is not caller-settable/);
  });

  it.each([
    'LD_PRELOAD',
    'LD_AUDIT',
    'LD_LIBRARY_PATH',
    'NODE_OPTIONS',
    'GIT_SSH_COMMAND',
    'BASH_ENV',
    'PYTHONSTARTUP',
  ])('rejects the loader/hook key %s', (key) => {
    expect(() => filterCallerEnv({ [key]: 'x' })).toThrow(
      new RegExp(`"${key}" is not caller-settable`),
    );
  });

  it('names the FIRST offending key when several are present', () => {
    // A near-miss (GIT_ prefix is NOT allow-listed; only LC_/REVDEV_ are).
    expect(() => filterCallerEnv({ GIT_CONFIG_GLOBAL: '/tmp/x' })).toThrow(/"GIT_CONFIG_GLOBAL"/);
  });
});

// ---------------------------------------------------------------------------
// buildConfinedEnv — deny-by-default baseline, no process.env leak
// ---------------------------------------------------------------------------

describe('buildConfinedEnv', () => {
  it('points HOME at the agent home and pins PATH', () => {
    const env = buildConfinedEnv({}, '/data/agent-homes/abc');
    expect(env.HOME).toBe('/data/agent-homes/abc');
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
  });

  it('does not inherit process.env (no secret leak)', () => {
    process.env.CONFINEMENT_SECRET_PROBE = 'leak-me';
    try {
      const env = buildConfinedEnv({}, '/data/agent');
      expect(env.CONFINEMENT_SECRET_PROBE).toBeUndefined();
    } finally {
      delete process.env.CONFINEMENT_SECRET_PROBE;
    }
  });

  it('layers allow-listed caller env on top', () => {
    const env = buildConfinedEnv({ TERM: 'screen-256color', REVDEV_X: '1' }, '/data/agent');
    expect(env.TERM).toBe('screen-256color');
    expect(env.REVDEV_X).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// linuxBubblewrapBackend — argv construction (spec §4.3, §4.4, §10 test 4)
// ---------------------------------------------------------------------------

describe('linuxBubblewrapBackend.spawnConfined', () => {
  const backend = linuxBubblewrapBackend('/usr/bin/bwrap');
  const opts = {
    repoReal: '/home/op/repo',
    cwd: '/home/op/repo/packages/x',
    agentHome: '/home/op/.local/share/revealui/agent-homes/deadbeef',
    operatorHome: '/home/op',
  };

  it('execs bwrap, not the raw command', () => {
    const { file } = backend.spawnConfined('bash', ['-i'], opts);
    expect(file).toBe('/usr/bin/bwrap');
  });

  it('still wraps an ABSOLUTE command — PATH was never the control (§10 test 4)', () => {
    const { file, argv } = backend.spawnConfined('/bin/bash', [], opts);
    expect(file).toBe('/usr/bin/bwrap');
    // The command sits AFTER the `--` separator, never as the exec file.
    const sep = argv.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(argv[sep + 1]).toBe('/bin/bash');
  });

  it('tmpfs-hides the operator home and re-binds only the granted root + agent home', () => {
    const { argv } = backend.spawnConfined('bash', [], opts);
    const s = argv.join(' ');
    expect(s).toContain('--tmpfs /home/op');
    expect(s).toContain(`--bind ${opts.repoReal} ${opts.repoReal}`);
    expect(s).toContain(`--bind ${opts.agentHome} ${opts.agentHome}`);
    // The operator-home tmpfs must come BEFORE the re-binds, or the binds get wiped.
    const tmpfsIdx = argv.indexOf('/home/op'); // the --tmpfs operand
    const repoBindIdx = argv.indexOf(opts.repoReal);
    expect(tmpfsIdx).toBeLessThan(repoBindIdx);
  });

  it('never binds a secret path', () => {
    const { argv } = backend.spawnConfined('bash', [], opts);
    const s = argv.join(' ');
    for (const secret of [
      '.ssh',
      '.age-identity',
      'passage-store',
      '.config/gh',
      '.npmrc',
      '.aws',
    ]) {
      expect(s).not.toContain(secret);
    }
  });

  it('sets HOME + PATH authoritatively inside the sandbox', () => {
    const { argv } = backend.spawnConfined('bash', [], opts);
    const s = argv.join(' ');
    expect(s).toContain(`--setenv HOME ${opts.agentHome}`);
    expect(s).toContain('--setenv PATH /usr/bin:/bin');
  });

  it('unshares user/pid/ipc/uts/cgroup but NOT net, and dies with parent', () => {
    const { argv } = backend.spawnConfined('bash', [], opts);
    expect(argv).toContain('--unshare-user');
    expect(argv).toContain('--unshare-pid');
    expect(argv).toContain('--unshare-cgroup');
    expect(argv).not.toContain('--unshare-net');
    expect(argv).not.toContain('--new-session'); // §4.3 — breaks interactive job control
    expect(argv).toContain('--die-with-parent');
  });

  it('starts in the granted cwd', () => {
    const { argv } = backend.spawnConfined('bash', [], opts);
    const s = argv.join(' ');
    expect(s).toContain(`--chdir ${opts.cwd}`);
  });
});

// ---------------------------------------------------------------------------
// resolveConfinementBackend — fail-closed + escape hatch (spec §8)
// ---------------------------------------------------------------------------

describe('resolveConfinementBackend', () => {
  it('linux + usable bwrap → linux-bubblewrap', () => {
    const r = resolveConfinementBackend({
      platform: 'linux',
      bwrapPath: '/usr/bin/bwrap',
      escapeHatchEnv: '',
    });
    expect(r.mode).toBe('linux-bubblewrap');
    expect(r.backend).not.toBeNull();
    expect(r.escapeHatch).toBe(false);
  });

  it('linux WITHOUT usable bwrap → fail closed (backend null, not escape hatch)', () => {
    const r = resolveConfinementBackend({ platform: 'linux', bwrapPath: null, escapeHatchEnv: '' });
    expect(r.mode).toBe('none');
    expect(r.backend).toBeNull();
    expect(r.escapeHatch).toBe(false);
    expect(r.reason).toMatch(/fails closed/);
  });

  it.each(['darwin', 'win32'] as const)('%s → fail closed (no backend)', (platform) => {
    const r = resolveConfinementBackend({ platform, bwrapPath: null, escapeHatchEnv: '' });
    expect(r.backend).toBeNull();
    expect(r.escapeHatch).toBe(false);
    expect(r.reason).toMatch(/fails closed/);
  });

  it('escape hatch overrides every platform → unconfined, recorded', () => {
    const r = resolveConfinementBackend({
      platform: 'linux',
      bwrapPath: '/usr/bin/bwrap',
      escapeHatchEnv: 'none',
    });
    expect(r.mode).toBe('none');
    expect(r.backend).toBeNull();
    expect(r.escapeHatch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveBwrapAbsPath
// ---------------------------------------------------------------------------

describe('resolveBwrapAbsPath', () => {
  it('returns null for a nonexistent candidate', () => {
    expect(resolveBwrapAbsPath('/nonexistent/bwrap-xyz')).toBeNull();
  });

  it('rejects a non-root-owned candidate (any user-writable file in tmp)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bwrap-probe-'));
    try {
      const fake = join(dir, 'bwrap');
      await writeFile(fake, '#!/bin/sh\n', { mode: 0o755 });
      // Owned by the test user, not root → refused.
      expect(resolveBwrapAbsPath(fake)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ensureAgentHome (spec §5, §6)
// ---------------------------------------------------------------------------

describe('ensureAgentHome', () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agent-home-test-'));
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates a hashed home with a signing-OFF gitconfig and no signingkey', async () => {
    const home = await ensureAgentHome(dataDir, 'did:key:zSignerABC');
    expect(home).toContain(join(dataDir, 'agent-homes'));
    // Hashed — the raw agentId never appears in the path.
    expect(home).not.toContain('zSignerABC');

    const gitconfig = await readFile(join(home, '.gitconfig'), 'utf8');
    expect(gitconfig).toContain('gpgsign = false');
    expect(gitconfig).not.toContain('signingkey');

    // Writable scaffold dirs exist.
    for (const d of ['.cache', '.config', join('.local', 'share')]) {
      const s = await stat(join(home, d));
      expect(s.isDirectory()).toBe(true);
    }
  });

  it('is idempotent and stable per agentId', async () => {
    const a = await ensureAgentHome(dataDir, 'did:key:zStable');
    const b = await ensureAgentHome(dataDir, 'did:key:zStable');
    expect(a).toBe(b);
  });

  it('gives different agents different homes', async () => {
    const a = await ensureAgentHome(dataDir, 'did:key:zOne');
    const b = await ensureAgentHome(dataDir, 'did:key:zTwo');
    expect(a).not.toBe(b);
  });
});
