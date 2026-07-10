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
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@revealui/utils/logger';

const log = createLogger({ service: 'revdev-daemon/confinement' });

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
}

export interface ConfinementResult {
  /** The binary node-pty execs: the resolved bwrap abspath (confined), or the raw command (escape hatch). */
  file: string;
  /** Full argv. For bwrap: every sandbox flag, then `--`, then command + args. */
  argv: string[];
}

export interface ConfinementBackend {
  readonly name: string;
  spawnConfined(command: string, args: string[], opts: ConfinementOpts): ConfinementResult;
}

// ---------------------------------------------------------------------------
// bwrap resolution — once, to an absolute realpath, verified trustworthy
// ---------------------------------------------------------------------------

const BWRAP_CANDIDATE = '/usr/bin/bwrap';

/**
 * Resolve `bwrap` to an absolute realpath and verify it is root-owned and not
 * group- or other-writable (spec §4.2 invariant 1). Never resolved through a
 * caller-influenced PATH — a bare-name reference is shadowable, so the parent
 * spec's finding forbids it. Returns the abspath, or null if bwrap is absent,
 * not a regular file, not root-owned, or writable by non-root.
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
  if (st.uid !== 0) {
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
      const { repoReal, cwd, agentHome, operatorHome } = opts;
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
