/**
 * Unit tests for the confinement module (confinement.ts) — pure argv/env/backend
 * logic, no real spawn and no socket. The real-bwrap adversarial reads live in
 * confinement-integration.test.ts.
 *
 * @vitest-environment node
 */

import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertGrantedRootBindable,
  buildConfinedEnv,
  ensureAgentHome,
  filterCallerEnv,
  linuxBubblewrapBackend,
  neverBoundSet,
  resolveBwrapAbsPath,
  resolveConfinementBackend,
  resolveOperatorHome,
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
    expect(() => filterCallerEnv({ HOME: '/base/op' })).toThrow(/"HOME" is not caller-settable/);
  });

  it('rejects PATH', () => {
    expect(() => filterCallerEnv({ PATH: '/evil/bin' })).toThrow(/"PATH" is not caller-settable/);
  });

  it('rejects REVDEV_SPAWN_CONFINEMENT by name despite the REVDEV_ prefix (GAP-320b)', () => {
    expect(() => filterCallerEnv({ REVDEV_SPAWN_CONFINEMENT: 'none' })).toThrow(
      /"REVDEV_SPAWN_CONFINEMENT" is not caller-settable/,
    );
    // The deny check runs FIRST, so it wins even when a benign REVDEV_ key precedes it.
    expect(() => filterCallerEnv({ REVDEV_HINT: 'ok', REVDEV_SPAWN_CONFINEMENT: 'none' })).toThrow(
      /"REVDEV_SPAWN_CONFINEMENT" is not caller-settable/,
    );
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
    repoReal: '/base/op/repo',
    cwd: '/base/op/repo/packages/x',
    agentHome: '/base/op/.local/share/revealui/agent-homes/deadbeef',
    operatorHome: '/base/op',
    dataDir: '/base/op/.local/share/revealui',
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
    expect(s).toContain('--tmpfs /base/op');
    expect(s).toContain(`--bind ${opts.repoReal} ${opts.repoReal}`);
    expect(s).toContain(`--bind ${opts.agentHome} ${opts.agentHome}`);
    // The operator-home tmpfs must come BEFORE the re-binds, or the binds get wiped.
    const tmpfsIdx = argv.indexOf('/base/op'); // the --tmpfs operand
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

// ---------------------------------------------------------------------------
// assertGrantedRootBindable — the overlap guard (GAP-320a, spec §4.3)
// ---------------------------------------------------------------------------

describe('assertGrantedRootBindable', () => {
  const HOME = '/base/op';
  const DATADIR = '/base/op/.local/share/revealui';

  it('refuses the operator home itself', () => {
    expect(() => assertGrantedRootBindable(HOME, HOME, DATADIR)).toThrow(
      /is or contains the operator home/,
    );
  });

  it('refuses an ANCESTOR of the operator home', () => {
    // repoReal = /base contains /base/op — the tmpfs-then-bind would carry the home.
    expect(() => assertGrantedRootBindable('/base', HOME, DATADIR)).toThrow(
      /is or contains the operator home/,
    );
  });

  it('refuses a granted root that IS a secret path', () => {
    expect(() => assertGrantedRootBindable(join(HOME, '.ssh'), HOME, DATADIR)).toThrow(
      /overlaps the never-bound secret path/,
    );
  });

  it('refuses a granted root INSIDE a secret path', () => {
    expect(() => assertGrantedRootBindable(join(HOME, '.ssh', 'sub'), HOME, DATADIR)).toThrow(
      /overlaps the never-bound secret path/,
    );
  });

  it('refuses a granted root that CONTAINS a secret path (.revealui over passage-store)', () => {
    // repoReal = <home>/.revealui contains <home>/.revealui/passage-store.
    expect(() => assertGrantedRootBindable(join(HOME, '.revealui'), HOME, DATADIR)).toThrow(
      /overlaps the never-bound secret path/,
    );
  });

  it('refuses the absolute NTFS mounts', () => {
    // A root INSIDE the first NTFS mount (within direction), and the second mount
    // itself (equal direction). Fixtures avoid the Windows-user and trailing-slash
    // mount shapes the private-leak scanner flags — the refusal is identical for
    // any path on those mounts.
    expect(() => assertGrantedRootBindable('/mnt/c/project', HOME, DATADIR)).toThrow(
      /overlaps the never-bound secret path/,
    );
    expect(() => assertGrantedRootBindable('/mnt/e', HOME, DATADIR)).toThrow(
      /overlaps the never-bound secret path/,
    );
  });

  it('refuses a granted root that IS the daemon data dir', () => {
    expect(() => assertGrantedRootBindable(DATADIR, HOME, DATADIR)).toThrow(
      /overlaps the never-bound secret path/,
    );
  });

  it('refuses a granted root that CONTAINS the daemon data dir', () => {
    // repoReal = <home>/.local/share contains the daemon dir under it.
    expect(() => assertGrantedRootBindable(join(HOME, '.local', 'share'), HOME, DATADIR)).toThrow(
      /overlaps the never-bound secret path/,
    );
  });

  it('refuses the daemon data dir even when it is configured OUTSIDE the home', () => {
    const outHome = '/var/lib/revealui-daemon';
    expect(() => assertGrantedRootBindable(outHome, HOME, outHome)).toThrow(
      /overlaps the never-bound secret path/,
    );
    // A root beneath it (e.g. the grants DB dir) is refused too.
    expect(() => assertGrantedRootBindable(`${outHome}/pglite`, HOME, outHome)).toThrow(
      /overlaps the never-bound secret path/,
    );
  });

  it('does NOT refuse the normal case: a project root beneath the home', () => {
    // The supported shape — ~/revfleet/<repo>. Must NOT throw.
    expect(() =>
      assertGrantedRootBindable(join(HOME, 'revfleet', 'revealui'), HOME, DATADIR),
    ).not.toThrow();
  });

  it('does NOT refuse a sibling of the home that shares a name prefix (separator-safe)', () => {
    // /base/op-scratch must not match /base/op via a naive startsWith.
    expect(() => assertGrantedRootBindable('/base/op-scratch/repo', HOME, DATADIR)).not.toThrow();
  });

  it('does NOT refuse a repo whose name merely prefixes a secret name (.sshkeep)', () => {
    // <home>/.sshkeep is not <home>/.ssh — separator-safe within() must not match.
    expect(() => assertGrantedRootBindable(join(HOME, '.sshkeep'), HOME, DATADIR)).not.toThrow();
  });

  it('refuses a SYMLINKED secret dir via the realpath-if-exists form', async () => {
    // Fixture: a real operator-home layout where <home>/.ssh -> <home>/real-ssh.
    // A grant of the symlink TARGET (which is what requireRootAndDir realpaths to)
    // must still be refused, even though the lexical secret entry is <home>/.ssh.
    const home = await mkdtemp(join(tmpdir(), 'nb-symlink-'));
    try {
      const target = join(home, 'real-ssh');
      await mkdir(target, { recursive: true });
      await symlink(target, join(home, '.ssh'));
      // realpath the target the same way requireRootAndDir would hand it in.
      const repoReal = await realpath(target);
      expect(() => assertGrantedRootBindable(repoReal, home, join(home, 'daemon-data'))).toThrow(
        /overlaps the never-bound secret path/,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('resolveOperatorHome (GAP-320a review S1)', () => {
  it('realpaths a symlinked home so the guard compares canonical paths', async () => {
    // /real-home is the true dir; /link-home is a symlink to it. Resolving the
    // symlink yields the same canonical path repoReal would realpath to.
    const base = await mkdtemp(join(tmpdir(), 'op-home-'));
    try {
      const realHome = join(base, 'real-home');
      const linkHome = join(base, 'link-home');
      await mkdir(realHome, { recursive: true });
      await symlink(realHome, linkHome);
      expect(await resolveOperatorHome(linkHome)).toBe(await realpath(realHome));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('falls back to the lexical value when the path does not resolve', () => {
    expect(resolveOperatorHome('/no/such/dir/xyzzy')).toBe('/no/such/dir/xyzzy');
  });
});

describe('neverBoundSet', () => {
  it('materializes the home-relative secrets and absolute mounts', () => {
    const set = neverBoundSet('/base/op', '/base/op/.local/share/revealui');
    for (const p of [
      '/base/op/.ssh',
      '/base/op/.age-identity',
      '/base/op/.revealui/passage-store',
      '/base/op/.config/gh',
      '/base/op/.npmrc',
      '/base/op/.aws',
      '/base/op/.docker/config.json',
      '/base/op/.claude',
      '/mnt/c',
      '/mnt/e',
    ]) {
      expect(set).toContain(p);
    }
  });

  it('includes /run/user/<uid> when getuid is available', () => {
    if (typeof process.getuid !== 'function') return;
    const set = neverBoundSet('/base/op', '/base/op/.local/share/revealui');
    expect(set).toContain(`/run/user/${process.getuid()}`);
  });
});

// ---------------------------------------------------------------------------
// spawnConfined guard wiring — the backend refuses an overlapping root (GAP-320a)
// ---------------------------------------------------------------------------

describe('linuxBubblewrapBackend.spawnConfined — overlap guard', () => {
  const backend = linuxBubblewrapBackend('/usr/bin/bwrap');
  const base = {
    cwd: '/base/op/.ssh',
    agentHome: '/base/op/.local/share/revealui/agent-homes/deadbeef',
    operatorHome: '/base/op',
    dataDir: '/base/op/.local/share/revealui',
  };

  it('refuses to build argv when the granted root overlaps a secret path', () => {
    expect(() => backend.spawnConfined('bash', [], { ...base, repoReal: '/base/op/.ssh' })).toThrow(
      /overlaps the never-bound secret path/,
    );
  });

  it('refuses to build argv when the granted root overlaps the daemon data dir', () => {
    expect(() =>
      backend.spawnConfined('bash', [], {
        ...base,
        repoReal: '/base/op/.local/share/revealui',
        cwd: '/base/op/.local/share/revealui',
      }),
    ).toThrow(/overlaps the never-bound secret path/);
  });

  it('still builds argv for a normal project root beneath the home', () => {
    const { argv } = backend.spawnConfined('bash', [], {
      repoReal: '/base/op/revfleet/repo',
      cwd: '/base/op/revfleet/repo',
      agentHome: base.agentHome,
      operatorHome: base.operatorHome,
      dataDir: base.dataDir,
    });
    expect(argv).toContain('--bind');
    expect(argv.join(' ')).toContain('--bind /base/op/revfleet/repo /base/op/revfleet/repo');
  });
});
