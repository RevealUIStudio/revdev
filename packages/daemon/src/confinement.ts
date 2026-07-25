/**
 * agent.spawn confinement — the kernel boundary (Phase 1).
 *
 * Spec: `.jv` docs/specs/2026-07-10-agent-spawn-confinement-phase-1.md (GAP-288).
 *
 * A verified, authorized `agent.spawn` still runs as the daemon UID with the
 * daemon's entire filesystem view. Env-scoping (a curated HOME + minimal PATH)
 * does NOT contain it: `open("/home/<op>/.ssh/id")` never consults $HOME, so a
 * deliberate reader ignores it. The only real boundary is an OS one.
 *
 * This module resolves the actual argv handed to node-pty. On Linux and WSL2 it
 * wraps the command in `bwrap` (bubblewrap) with a deny-by-default bind set:
 * nothing is visible inside the sandbox unless explicitly bound, and the
 * operator's home is tmpfs'd so `~/.ssh`, `~/.age-identity`, and the revvault
 * store are gone. On platforms with no backend it FAILS CLOSED — a caller can
 * never tell an absent sandbox from a broken one, so the absent case refuses.
 *
 * Confinement does NOT replace authorization. `requireDirInRoot` still decides
 * WHICH root is bound; a defect here must never grant a root the caller was not
 * granted (spec §4.2 invariant 3).
 */

import { createHash } from 'node:crypto';
import { existsSync, constants as fsConstants, realpathSync, statSync } from 'node:fs';
import { open as fsOpen, lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createLogger } from '@revealui/utils/logger';

const log = createLogger({ service: 'revdev-daemon/confinement' });

/**
 * True when `target` is `root` itself or a descendant of it. Separator-safe
 * (never a bare `startsWith`, which would treat `/a/bc` as within `/a/b`).
 * Local to this module — same shape as filegit.ts `within()`, kept here so the
 * confinement layer carries no dependency on the file layer. Zero regex.
 */
function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

export interface ConfinementOpts {
  /** Realpath'd granted root (from requireRootAndDir) — bound read-write. */
  repoReal: string;
  /** Directory the sandboxed process starts in (at or beneath repoReal). */
  cwd: string;
  /** Per-agent persistent home (§5), bound read-write; HOME points here. */
  agentHome: string;
  /** The operator's real home; tmpfs'd to hide everything beneath it. */
  operatorHome: string;
  /**
   * The daemon data directory (`getDaemonConfig().dataDir`, default
   * `~/.local/share/revealui`). Never-bound: it holds the PGlite integrity DB
   * (grants, identities, roots), the control socket, and the per-agent homes —
   * a confined agent that could read/write it could rewrite its own
   * authorization state. A specific per-agent home subdir IS bound (that is the
   * agent's own home); the guard only refuses a GRANTED ROOT overlapping dataDir.
   */
  dataDir: string;
}

export interface ConfinementResult {
  /** The binary node-pty execs: the resolved bwrap abspath (confined), or the raw command (escape hatch). */
  file: string;
  /** Full argv. For bwrap: every sandbox flag, then `--`, then command + args. */
  argv: string[];
}

export interface ConfinementBackend {
  readonly name: string;
  /**
   * Resolve the argv for this backend. Every backend MUST validate the granted
   * root against the never-bound secret set (via `assertGrantedRootBindable`)
   * before building its argv — a backend that skips it re-exposes secrets a
   * broad grant overlaps (GAP-320a). Throws the guard's named error on overlap.
   */
  spawnConfined(command: string, args: string[], opts: ConfinementOpts): ConfinementResult;
}

// ---------------------------------------------------------------------------
// bwrap resolution — once, to an absolute realpath, verified trustworthy
// ---------------------------------------------------------------------------

const BWRAP_CANDIDATE = '/usr/bin/bwrap';

/**
 * Under systemd-user on WSL (and some idmapped mounts), `stat.uid` for
 * root-owned files in `/usr` is reported as 65534 (`nobody`) even though the
 * file is truly root:root on the host. Detect that squash by checking a
 * known system binary that is always root-owned on a sane distro.
 *
 * When the squash is active, accepting uid 65534 for a non-group/other-writable
 * `/usr/bin/bwrap` is the only way confinement can arm inside a user unit.
 * When the squash is NOT active, uid 65534 remains untrusted.
 */
export function systemRootUidIsSquashedToNobody(): boolean {
  try {
    const st = statSync('/usr/bin/true');
    return st.isFile() && st.uid === 65534;
  } catch {
    return false;
  }
}

/**
 * True when the stat result is an acceptable ROOT owner for a trust-critical
 * filesystem entry (the bwrap binary, the client trust anchor and its
 * ancestors):
 * - Normal: uid 0 (root)
 * - WSL systemd-user idmap: uid 65534 only if the whole system root→nobody
 *   squash is observed on `/usr/bin/true` as well
 *
 * A genuinely nobody-owned file on a non-squashed system never passes
 * (fail-closed, GAP-409 D8).
 */
export function isTrustedRootOwner(st: { uid: number }): boolean {
  if (st.uid === 0) return true;
  if (st.uid === 65534 && systemRootUidIsSquashedToNobody()) return true;
  return false;
}

/**
 * True when the stat result is an acceptable owner for the bwrap binary.
 * Same semantics as `isTrustedRootOwner` — kept as a named alias because the
 * bwrap call sites and tests predate the shared predicate (revdev#304).
 */
export function isTrustedBwrapOwner(st: { uid: number }): boolean {
  return isTrustedRootOwner(st);
}

/**
 * Read a file that MUST be root-owned and tamper-resistant: every ancestor
 * directory must be a root-owned, non-symlink directory with no group/other
 * write bit, and the file itself is opened O_NOFOLLOW then fstat-checked
 * (regular file, trusted-root-owned, not group/other-writable). Throws
 * otherwise.
 *
 * "Root-owned" is `isTrustedRootOwner`: uid 0 always; uid 65534 only under
 * the proven WSL systemd-user idmap squash (GAP-409 D7). Every other
 * property — non-symlink ancestors, write-bit checks, O_NOFOLLOW + fstat —
 * is unchanged from the strict form.
 */
export async function readRootOwnedFile(filePath: string): Promise<string> {
  let dir = dirname(resolve(filePath));
  for (;;) {
    const dstat = await lstat(dir);
    if (dstat.isSymbolicLink()) throw new Error(`anchor ancestor is a symlink: ${dir}`);
    if (!dstat.isDirectory()) throw new Error(`anchor ancestor is not a directory: ${dir}`);
    if (!isTrustedRootOwner(dstat))
      throw new Error(`anchor ancestor not root-owned (uid ${dstat.uid}): ${dir}`);
    if ((dstat.mode & 0o022) !== 0) throw new Error(`anchor ancestor group/other-writable: ${dir}`);
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  const handle = await fsOpen(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const fstat = await handle.stat();
    if (!fstat.isFile()) throw new Error(`trust anchor is not a regular file: ${filePath}`);
    if (!isTrustedRootOwner(fstat))
      throw new Error(`trust anchor not root-owned (uid ${fstat.uid}): ${filePath}`);
    if ((fstat.mode & 0o022) !== 0)
      throw new Error(`trust anchor group/other-writable: ${filePath}`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Resolve `bwrap` to an absolute realpath and verify it is root-owned (or
 * idmap-squashed root — see `isTrustedBwrapOwner`) and not group- or
 * other-writable (spec §4.2 invariant 1). Never resolved through a
 * caller-influenced PATH — a bare-name reference is shadowable, so the parent
 * spec's finding forbids it. Returns the abspath, or null if bwrap is absent,
 * not a regular file, not trusted-owned, or writable by non-root.
 */
export function resolveBwrapAbsPath(candidate: string = BWRAP_CANDIDATE): string | null {
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(real);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (!isTrustedBwrapOwner(st)) {
    log.warn('bwrap is not root-owned; refusing to use it', { path: real, uid: st.uid });
    return null;
  }
  // Group-writable (0o020) or other-writable (0o002) means a non-root principal
  // could replace the boundary binary. Reject.
  if ((st.mode & 0o022) !== 0) {
    log.warn('bwrap is group- or other-writable; refusing to use it', {
      path: real,
      mode: (st.mode & 0o777).toString(8),
    });
    return null;
  }
  return real;
}

// ---------------------------------------------------------------------------
// Caller env allow-list (spec §7)
// ---------------------------------------------------------------------------

/** Exact keys a caller may set. */
const CALLER_ENV_EXACT = new Set(['TERM', 'LANG', 'CI', 'NO_COLOR']);
/** Namespaced prefixes a caller may set. */
const CALLER_ENV_PREFIXES = ['LC_', 'REVDEV_'] as const;
/**
 * Daemon-control keys a caller may NEVER set, even under an allowed prefix
 * (GAP-320b). Membership criterion: an env var the daemon itself reads to
 * configure or WEAKEN a security boundary. `REVDEV_SPAWN_CONFINEMENT` is the
 * only member — it is inert in a child today (resolveConfinementBackend reads
 * only the daemon's own `process.env`, never caller env), but a caller-seedable
 * escape-hatch key sitting in a sandboxed process's environment invites a future
 * misread that it is load-bearing. Prune knobs (`REVDEV_STALE_THRESHOLD_DAYS`,
 * `REVDEV_HARD_DELETE_DAYS`) do NOT qualify: they configure nothing in a child
 * and mislead nobody about a boundary. Keep this set tiny — the allow-list is
 * the load-bearing control; a deny-list always loses eventually.
 */
const CALLER_ENV_DENY_EXACT = new Set(['REVDEV_SPAWN_CONFINEMENT']);

/**
 * Filter caller-supplied env to the allow-list. A deny-list of dangerous keys
 * always loses eventually, so this is an allow-list: `HOME`, `PATH`, the loader
 * set (`LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`,
 * `GIT_CONFIG_GLOBAL`, `GIT_SSH_COMMAND`, `BASH_ENV`, `PYTHONSTARTUP`, …) are
 * simply not on it and are rejected by name. Zero authored regex — a Set
 * membership test plus `startsWith` for the namespaces.
 *
 * @throws naming the first disallowed key.
 */
export function filterCallerEnv(extraEnv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(extraEnv)) {
    // Daemon-control keys are rejected FIRST, before the prefix allowance that
    // would otherwise wave `REVDEV_SPAWN_CONFINEMENT` through (GAP-320b).
    if (CALLER_ENV_DENY_EXACT.has(k)) {
      throw new Error(
        `agent.spawn: env key "${k}" is not caller-settable — it is a daemon-control key that configures the confinement boundary (the REVDEV_ prefix is otherwise allowed).`,
      );
    }
    if (CALLER_ENV_EXACT.has(k)) {
      out[k] = v;
      continue;
    }
    let allowed = false;
    for (const prefix of CALLER_ENV_PREFIXES) {
      if (k.startsWith(prefix)) {
        allowed = true;
        break;
      }
    }
    if (allowed) {
      out[k] = v;
      continue;
    }
    throw new Error(
      `agent.spawn: env key "${k}" is not caller-settable. Allowed: TERM, LANG, LC_*, CI, NO_COLOR, REVDEV_*.`,
    );
  }
  return out;
}

/**
 * Build the environment node-pty is given (and, without --clearenv, that bwrap
 * inherits before its own --setenv). `process.env` is deliberately NOT
 * inherited — the daemon's revvault secrets, signing material, and API keys
 * never reach the child. HOME points at the per-agent home; PATH is fixed.
 * Allow-listed caller env layers on top but can never contain HOME or PATH
 * (filterCallerEnv rejected them upstream).
 */
export function buildConfinedEnv(
  callerEnv: Record<string, string>,
  agentHome: string,
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: agentHome,
    PATH: '/usr/bin:/bin',
    TERM: 'xterm-color',
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const [k, v] of Object.entries(callerEnv)) env[k] = v;
  return env;
}

// ---------------------------------------------------------------------------
// linux-bubblewrap backend (spec §4.3)
// ---------------------------------------------------------------------------

/** /etc entries bound read-only for DNS, TLS, and name resolution (only if present). */
const ETC_RO_BINDS = [
  '/etc/resolv.conf',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/passwd',
  '/etc/group',
  '/etc/nsswitch.conf',
  '/etc/alternatives',
] as const;

// ---------------------------------------------------------------------------
// Never-bound secret set + granted-root overlap guard (spec §4.3, GAP-320a)
// ---------------------------------------------------------------------------

/** Home-relative secret paths (spec §4.3), joined onto the operator home. */
const NEVER_BOUND_HOME_RELATIVE = [
  '.ssh',
  '.age-identity',
  '.revealui/passage-store',
  '.config/gh',
  '.npmrc',
  '.aws',
  '.docker/config.json',
  '.claude',
] as const;

/** Absolute mounts that must never be bound (spec §4.3). No development happens
 *  on the NTFS mounts; /mnt/c carries the Windows credential stores, /mnt/e the
 *  LTS backups. */
const NEVER_BOUND_ABSOLUTE = ['/mnt/c', '/mnt/e'] as const;

/**
 * Materialize spec §4.3's never-bound secret set for this host, from the
 * operator home and the daemon data directory. Each entry is carried in two
 * forms: its lexical path, and its realpath WHEN the entry exists
 * (realpath-if-exists). Rationale: `repoReal` arrives already realpath'd
 * (requireRootAndDir), so a lexical-only compare misses a secret directory that
 * is itself a symlink (`~/.ssh -> /data/ssh`). Entries absent on this host stay
 * lexical-only. Computed per spawn (a handful of joins plus at most a few
 * stats), so a secret path or symlink that appears after daemon start is guarded
 * without a restart. Zero authored regex.
 *
 * `dataDir` is included because it holds the daemon's integrity DB, control
 * socket, and per-agent homes (the authorization state itself); it is often but
 * not always under the operator home, so it gets its own entry regardless of
 * where it is configured.
 */
export function neverBoundSet(operatorHome: string, dataDir: string): string[] {
  const lexical: string[] = [
    ...NEVER_BOUND_HOME_RELATIVE.map((p) => join(operatorHome, p)),
    ...NEVER_BOUND_ABSOLUTE,
    dataDir,
  ];
  // /run/user/<uid> carries the ssh-agent socket (spec §4.3).
  if (typeof process.getuid === 'function') {
    lexical.push(`/run/user/${process.getuid()}`);
  }
  const out = new Set<string>(lexical);
  for (const p of lexical) {
    try {
      out.add(realpathSync(p));
    } catch {
      // absent on this host — the lexical form stays, realpath is skipped
    }
  }
  return [...out];
}

/**
 * Return the first never-bound entry that overlaps `real` in either direction,
 * or `null` when none does. Pure, zero I/O (the caller passes a precomputed
 * `neverBound` list) and zero regex — the shared overlap predicate.
 *
 *   - `within(real, nb)`: the secret lives INSIDE `real` (a bind/read exposes it).
 *   - `within(nb, real)`: `real` IS or lives INSIDE a secret path.
 *
 * Consumed by BOTH the spawn side (`assertGrantedRootBindable`, which formats a
 * full-path error because a granted root is operator-known material) and the
 * file side (`filegit.ts` D1/D2/D3, which formats a CLASS-only error because a
 * `project.open` caller may be hostile). One never-bound set (`neverBoundSet`),
 * one predicate, no copied logic (extend-before-create, GAP-326).
 */
export function findNeverBoundOverlap(real: string, neverBound: readonly string[]): string | null {
  for (const nb of neverBound) {
    if (within(real, nb) || within(nb, real)) return nb;
  }
  return null;
}

/**
 * Refuse to bind a granted root that overlaps the never-bound secret set or the
 * operator home (GAP-320a). The bind sequence tmpfs-hides the operator home and
 * then re-binds `repoReal` read-write on top (§4.3); if `repoReal` IS, CONTAINS,
 * or lives INSIDE a secret path, that rw bind re-exposes the secret inside the
 * sandbox. We REFUSE (fail closed) rather than mask: a mask that misses a path
 * exposes it silently, whereas an over-broad refusal fails loud and is fixed the
 * same day. Confinement does not replace authorization (spec §4.2 invariant 3) —
 * this only refuses grants the confinement layer cannot actually confine.
 *
 * `repoReal` BENEATH the operator home (`within(operatorHome, repoReal)`) is the
 * normal, supported case (`~/revfleet/<repo>`) and is NOT refused. Every backend
 * MUST call this before building its argv (see the ConfinementBackend contract).
 *
 * @throws naming the granted root, the colliding path, and the reason. Both are
 *   operator-known material (their own home layout), so naming them is not an oracle.
 */
export function assertGrantedRootBindable(
  repoReal: string,
  operatorHome: string,
  dataDir: string,
): void {
  // repoReal IS the home, or is an ANCESTOR of it (e.g. `/base` over `/base/op`):
  // the tmpfs-then-bind sequence would re-expose the entire home read-write.
  if (repoReal === operatorHome || within(repoReal, operatorHome)) {
    throw new Error(
      `agent.spawn: refusing to bind granted root "${repoReal}" — it is or contains the operator home "${operatorHome}" (confinement would re-expose the entire home read-write). Grant a project root beneath the home, not the home itself.`,
    );
  }
  // within(repoReal, nb): the secret lives INSIDE the granted root (bind exposes it).
  // within(nb, repoReal): the granted root IS or lives INSIDE a secret path.
  const nb = findNeverBoundOverlap(repoReal, neverBoundSet(operatorHome, dataDir));
  if (nb !== null) {
    throw new Error(
      `agent.spawn: refusing to bind granted root "${repoReal}" — it overlaps the never-bound secret path "${nb}" (confinement would re-expose it read-write). Grant a root that does not contain secret material.`,
    );
  }
}

/**
 * Resolve the operator's real home, realpath'd. `assertGrantedRootBindable`
 * compares the home against an already-realpath'd `repoReal`, and the backend
 * tmpfs-hides this path; realpath'ing here keeps both consistent, so a symlinked
 * `$HOME` component can't make the guard's home-identity/ancestor checks
 * lexical-only and diverge from the canonical path (GAP-320a review S1). Falls
 * back to the lexical value when it does not resolve (e.g. an absent `/root`),
 * which never WIDENS the guard — the never-bound entries carry their own
 * realpath-if-exists forms, so a real secret is still caught.
 */
export function resolveOperatorHome(rawHome: string = process.env.HOME ?? '/root'): string {
  try {
    return realpathSync(rawHome);
  } catch {
    return rawHome;
  }
}

/**
 * The Linux/WSL2 backend. Builds a deny-by-default bwrap argv:
 *   - /usr read-only, the merged-usr symlinks, minimal /etc, /proc, /dev, /tmp;
 *   - the operator home tmpfs'd (hides everything beneath it), THEN the granted
 *     root and the per-agent home re-bound read-write on top;
 *   - shared caches (pnpm store, cargo registry/git) bound by EXACT subdirectory,
 *     never the secret-bearing parent, and only when they exist on the host;
 *   - HOME and PATH set authoritatively inside the sandbox;
 *   - user/pid/ipc/uts/cgroup namespaces unshared (NOT net — pnpm/cargo/claude
 *     need egress; NOT --new-session — it setsid()s and breaks interactive job
 *     control, and node-pty already hands a dedicated pty slave, spec §4.3).
 *
 * A symlink inside the repo pointing at ~/.ssh resolves against the SANDBOX
 * root, where ~/.ssh does not exist — symlink escape is closed for free (§4.4).
 */
export function linuxBubblewrapBackend(bwrapAbs: string): ConfinementBackend {
  return {
    name: 'linux-bubblewrap',
    spawnConfined(command, args, opts): ConfinementResult {
      const { repoReal, cwd, agentHome, operatorHome, dataDir } = opts;

      // Refuse a granted root that overlaps a secret path, the operator home, or
      // the daemon data dir BEFORE any argv is assembled — the invariant lives
      // next to the bind sequence that creates the hazard (GAP-320a, spec §4.3).
      assertGrantedRootBindable(repoReal, operatorHome, dataDir);

      const a: string[] = [];

      // System, read-only + merged-usr symlinks.
      a.push('--ro-bind', '/usr', '/usr');
      a.push('--symlink', 'usr/bin', '/bin');
      a.push('--symlink', 'usr/sbin', '/sbin');
      a.push('--symlink', 'usr/lib', '/lib');
      a.push('--symlink', 'usr/lib64', '/lib64');

      // Minimal /etc (each only if present on the host).
      for (const p of ETC_RO_BINDS) {
        if (existsSync(p)) a.push('--ro-bind', p, p);
      }

      // Kernel + device surfaces, and a private /tmp.
      a.push('--proc', '/proc');
      a.push('--dev', '/dev');
      a.push('--tmpfs', '/tmp');

      // Hide the entire operator home. Everything the caller is allowed to see
      // beneath it is re-bound AFTER this line (bwrap applies args in order).
      a.push('--tmpfs', operatorHome);

      // The granted root and the per-agent home, read-write.
      a.push('--bind', repoReal, repoReal);
      a.push('--bind', agentHome, agentHome);

      // Shared caches — bound by exact subdirectory, never `~/.cargo` (which may
      // hold `credentials`) or `~/.local/share` (which holds the daemon's own
      // DB). Only when present.
      const sharedCaches = [
        join(operatorHome, '.local/share/pnpm/store'),
        join(operatorHome, '.cargo/registry'),
        join(operatorHome, '.cargo/git'),
      ];
      for (const p of sharedCaches) {
        if (existsSync(p)) a.push('--bind', p, p);
      }

      // Authoritative in-sandbox HOME + PATH.
      a.push('--setenv', 'HOME', agentHome);
      a.push('--setenv', 'PATH', '/usr/bin:/bin');

      // Namespaces. NOT --unshare-net (kept: pnpm, cargo, claude need egress).
      a.push(
        '--unshare-user',
        '--unshare-pid',
        '--unshare-ipc',
        '--unshare-uts',
        '--unshare-cgroup',
      );
      a.push('--die-with-parent');

      // Start in the granted cwd (bound above), then the command.
      a.push('--chdir', cwd);
      a.push('--', command, ...args);

      return { file: bwrapAbs, argv: a };
    },
  };
}

// ---------------------------------------------------------------------------
// Backend resolution — fail-closed, with an operator escape hatch (spec §8)
// ---------------------------------------------------------------------------

export type ConfinementMode = 'linux-bubblewrap' | 'none';

export interface ResolvedConfinement {
  /** The value persisted in the `agent_processes.confinement` audit column. */
  mode: ConfinementMode;
  /** The active backend, or null when spawns must fail closed / run unconfined. */
  backend: ConfinementBackend | null;
  /** True only when confinement is deliberately disabled via the operator escape hatch. */
  escapeHatch: boolean;
  /** Human-readable reason, for the startup log and the fail-closed error. */
  reason: string;
}

/**
 * Resolve the confinement backend for this host. Called once at daemon start
 * and cached. Optional injections make it unit-testable without touching the
 * real filesystem or `process.platform`.
 *
 *   - `REVDEV_SPAWN_CONFINEMENT=none` in the DAEMON's own env (never a caller
 *     param): spawns run UNCONFINED, each logged at warn, each row recording
 *     `confinement='none'`. If an agent did it, there is a receipt.
 *   - Linux/WSL2 with a usable bwrap: `linux-bubblewrap`.
 *   - Linux without a usable bwrap, or macOS/Windows: no backend — agent.spawn
 *     FAILS CLOSED. An unimplemented platform refuses to spawn; it never
 *     silently spawns unprotected (spec §8.1).
 */
export function resolveConfinementBackend(opts?: {
  platform?: NodeJS.Platform;
  /** Resolved bwrap abspath or null. `undefined` (default) resolves for real. */
  bwrapPath?: string | null;
  /** The escape-hatch env value. `undefined` (default) reads process.env. */
  escapeHatchEnv?: string;
}): ResolvedConfinement {
  const platform = opts?.platform ?? process.platform;
  const escapeHatchValue =
    opts?.escapeHatchEnv !== undefined ? opts.escapeHatchEnv : process.env.REVDEV_SPAWN_CONFINEMENT;

  if (escapeHatchValue === 'none') {
    return {
      mode: 'none',
      backend: null,
      escapeHatch: true,
      reason: 'REVDEV_SPAWN_CONFINEMENT=none — spawns run UNCONFINED (operator escape hatch)',
    };
  }

  if (platform === 'linux') {
    const bwrapAbs = opts?.bwrapPath !== undefined ? opts.bwrapPath : resolveBwrapAbsPath();
    if (bwrapAbs) {
      return {
        mode: 'linux-bubblewrap',
        backend: linuxBubblewrapBackend(bwrapAbs),
        escapeHatch: false,
        reason: `linux-bubblewrap (${bwrapAbs})`,
      };
    }
    return {
      mode: 'none',
      backend: null,
      escapeHatch: false,
      reason:
        'no usable bwrap found (absent, not root-owned, or writable); agent.spawn fails closed',
    };
  }

  // macOS: the darwin-seatbelt backend is staged but disabled until its
  // acceptance suite is green on a macos-latest runner (spec §8.2/§8.3), so it
  // resolves to fail-closed today. Windows native: no backend.
  return {
    mode: 'none',
    backend: null,
    escapeHatch: false,
    reason: `no confinement backend for platform "${platform}"; agent.spawn fails closed (spec §8)`,
  };
}

// ---------------------------------------------------------------------------
// Per-agent persistent home (spec §5)
// ---------------------------------------------------------------------------

/**
 * Ensure the per-agent home exists at `<dataDir>/agent-homes/<hash(agentId)>/`
 * and return its path. Persistent (NOT per-spawn tmpfs — that would discard the
 * pnpm store links and node_modules state every spawn and make the daily driver
 * unusable; the sandbox is the per-spawn unit, the home is durable).
 *
 * `agentId` is the VERIFIED signer (requireAgent returns it only when
 * boundVia==='signature'), a signing-key identity — not the hook-side
 * `agent-system` string, so this does not inherit GAP-311's collision. The path
 * is hashed so a DID cannot traverse.
 *
 * Contains a synthesized minimal `.gitconfig` (identity present, signing OFF,
 * no signingkey — spec §6) and writable `.cache`, `.config`, `.local/share`.
 * Never contains anything on the never-bound list of §4.3.
 */
export async function ensureAgentHome(dataDir: string, agentId: string): Promise<string> {
  const hash = createHash('sha256').update(agentId).digest('hex').slice(0, 32);
  const home = join(dataDir, 'agent-homes', hash);
  await mkdir(join(home, '.cache'), { recursive: true });
  await mkdir(join(home, '.config'), { recursive: true });
  await mkdir(join(home, '.local', 'share'), { recursive: true });

  // Synthesized gitconfig: a spawned agent commits locally and UNSIGNED. It has
  // no ~/.ssh and no signing key, so it cannot forge a commit GitHub marks
  // Verified as the operator (spec §6 — "signing must break, and that is the
  // correct outcome"). commit.gpgsign is pinned false and user.signingkey omitted.
  const gitconfig = `${[
    '[user]',
    '\tname = RevealUI Agent',
    '\temail = agent@revealui.local',
    '[commit]',
    '\tgpgsign = false',
    '[tag]',
    '\tgpgsign = false',
  ].join('\n')}\n`;
  await writeFile(join(home, '.gitconfig'), gitconfig, { mode: 0o600 });

  return home;
}
