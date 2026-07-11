/**
 * Integration tests for confinement — REAL bwrap, real filesystem, real child
 * processes. Proves the boundary actually holds (spec §10 tests 1, 2, 5, 6) and
 * that the daily driver survives (test 6, repo read).
 *
 * Hermetic: a temp directory stands in for the operator home, seeded with fake
 * secrets. This runs on any bwrap-capable Linux/WSL2 host without touching the
 * real ~/.ssh, and is reproducible in CI. (§10's literal reads against the real
 * operator paths are additionally verified by hand on WSL2 — see the PR body.)
 *
 * PROVE-RED is built in: each adversarial read is run first WITHOUT the sandbox
 * (the `control` helper = the pre-fix behavior) and shown to LEAK, then WITH the
 * sandbox and shown DENIED. A test that can only pass because the sandbox exists.
 *
 * The whole suite is skipped when bwrap cannot create unprivileged namespaces
 * on the host (WSL1, hardened kernels, restricted CI) — that is the fail-closed
 * platform, and there is nothing to prove there.
 *
 * @vitest-environment node
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linuxBubblewrapBackend, resolveBwrapAbsPath } from '../confinement.js';

const bwrapAbs = process.platform === 'linux' ? resolveBwrapAbsPath() : null;

/**
 * Probe whether bwrap can actually create unprivileged namespaces here. Presence
 * of the binary is not enough (WSL1 / hardened kernels have it but it fails), so
 * we run a trivial real sandbox and require exit 0.
 */
function bwrapUsable(): boolean {
  if (!bwrapAbs) return false;
  // Mirror the backend's merged-usr symlinks — WITHOUT /lib and /lib64 the ELF
  // loader is missing inside and every exec fails ENOENT (a false negative).
  const r = spawnSync(
    bwrapAbs,
    [
      '--unshare-user',
      '--unshare-pid',
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/bin',
      '/bin',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/lib64',
      '/lib64',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--',
      '/bin/true',
    ],
    { timeout: 10_000 },
  );
  return r.status === 0;
}

const RUN = bwrapUsable();

describe.skipIf(!RUN)('confinement integration (real bwrap)', () => {
  const backend = linuxBubblewrapBackend(bwrapAbs as string);

  let operatorHome: string;
  let repoReal: string;
  let agentHome: string;
  let sshSecret: string;
  let ageSecret: string;

  beforeAll(async () => {
    operatorHome = await mkdtemp(join(tmpdir(), 'confine-op-'));
    repoReal = join(operatorHome, 'repo');
    agentHome = join(operatorHome, 'agent');
    sshSecret = join(operatorHome, '.ssh', 'id_secret');
    ageSecret = join(operatorHome, '.age-identity');

    await mkdir(join(operatorHome, '.ssh'), { recursive: true });
    await writeFile(sshSecret, 'TOPSECRET-SSH-KEY\n', { mode: 0o600 });
    await writeFile(ageSecret, 'AGE-SECRET-IDENTITY\n', { mode: 0o600 });
    await mkdir(repoReal, { recursive: true });
    await writeFile(join(repoReal, 'hello.txt'), 'REPO-VISIBLE\n');
    await mkdir(agentHome, { recursive: true });
    // A symlink inside the granted repo pointing at the ssh secret (§4.4 escape).
    await symlink(sshSecret, join(repoReal, 'escape-link'));
  });

  afterAll(async () => {
    await rm(operatorHome, { recursive: true, force: true });
  });

  /** Run `sh -c script` INSIDE the sandbox; return combined stdout. */
  function confined(script: string): { status: number | null; out: string } {
    const { file, argv } = backend.spawnConfined('/bin/sh', ['-c', script], {
      repoReal,
      cwd: repoReal,
      agentHome,
      operatorHome,
    });
    const r = spawnSync(file, argv, { encoding: 'utf8', timeout: 15_000 });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  /** Run `sh -c script` WITHOUT the sandbox (the pre-fix control = prove-red). */
  function control(script: string): { status: number | null; out: string } {
    const r = spawnSync('/bin/sh', ['-c', script], {
      cwd: repoReal,
      encoding: 'utf8',
      timeout: 15_000,
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  const readProbe = (p: string) => `cat '${p}' 2>/dev/null && echo __LEAK__ || echo __DENIED__`;

  it('CONTROL: the ssh secret is readable WITHOUT the sandbox (prove-red)', () => {
    const { out } = control(readProbe(sshSecret));
    expect(out).toContain('TOPSECRET-SSH-KEY');
    expect(out).toContain('__LEAK__');
  });

  it('denies reading ~/.ssh inside the sandbox (§10 test 1)', () => {
    const { out } = confined(readProbe(sshSecret));
    expect(out).not.toContain('TOPSECRET-SSH-KEY');
    expect(out).toContain('__DENIED__');
  });

  it('denies reading ~/.age-identity inside the sandbox (§10 test 2)', () => {
    expect(control(readProbe(ageSecret)).out).toContain('AGE-SECRET-IDENTITY'); // prove-red
    const { out } = confined(readProbe(ageSecret));
    expect(out).not.toContain('AGE-SECRET-IDENTITY');
    expect(out).toContain('__DENIED__');
  });

  it('cannot read a secret THROUGH a repo symlink (§10 test 5, §4.4)', () => {
    const link = join(repoReal, 'escape-link');
    expect(control(readProbe(link)).out).toContain('TOPSECRET-SSH-KEY'); // prove-red: link works unsandboxed
    const { out } = confined(readProbe(link));
    expect(out).not.toContain('TOPSECRET-SSH-KEY');
    expect(out).toContain('__DENIED__');
  });

  it('DAILY DRIVER: the granted repo IS readable inside the sandbox (§10 test 6)', () => {
    const { out } = confined(`cat '${join(repoReal, 'hello.txt')}'`);
    expect(out).toContain('REPO-VISIBLE');
  });

  it('refuses a spawn whose granted root overlaps a real fixture secret (GAP-320a §5.D)', () => {
    // End-to-end against the seeded operator-home layout: a granted root that IS
    // the operator home, or that lives inside the seeded ~/.ssh, is refused by
    // name before any sandbox is built — while the sibling happy-path spawn above
    // still succeeds (DAILY DRIVER). The guard fires in spawnConfined, so this
    // exercises the real entrypoint with a real secret-bearing home on disk.
    expect(() =>
      backend.spawnConfined('/bin/sh', ['-c', 'true'], {
        repoReal: operatorHome,
        cwd: operatorHome,
        agentHome,
        operatorHome,
      }),
    ).toThrow(/is or contains the operator home/);
    expect(() =>
      backend.spawnConfined('/bin/sh', ['-c', 'true'], {
        repoReal: join(operatorHome, '.ssh'),
        cwd: join(operatorHome, '.ssh'),
        agentHome,
        operatorHome,
      }),
    ).toThrow(/overlaps the never-bound secret path/);
  });

  it('HOME points at the agent home, not the operator home', () => {
    const { out } = confined('echo "HOME=$HOME"');
    expect(out).toContain(`HOME=${agentHome}`);
  });

  it('an ABSOLUTE command is still confined — PATH was never the control (§10 test 4)', () => {
    // /bin/cat by absolute path; the ssh secret is still denied.
    const { out } = confined(
      `/bin/cat '${sshSecret}' 2>/dev/null && echo __LEAK__ || echo __DENIED__`,
    );
    expect(out).not.toContain('TOPSECRET-SSH-KEY');
    expect(out).toContain('__DENIED__');
  });
});
