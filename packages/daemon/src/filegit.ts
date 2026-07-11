/**
 * file.* / git.* handlers — daemon-owned ext4 file and git I/O (ADR
 * 2026-06-23, "RevDev as a zero-9P WSL-native dev surface", P0).
 *
 * The daemon runs as a Linux process on the WSL ext4 filesystem, so every
 * read/write/commit it performs is coherent. Studio (Windows) becomes a pure
 * RPC client and never touches a project path through the 9P (`\\wsl$`)
 * redirector, eliminating the stale-read / phantom-git-metadata failure
 * class by construction rather than guarding it per call.
 *
 * Three layered barriers gate this surface (the 0600 socket alone is NOT
 * sufficient — any host process can `wsl.exe` in as the WSL user and reach
 * the socket):
 *   1. Socket + parent-dir mode (0600 / 0700) — see server.ts.
 *   2. Required Ed25519 signature on every mutation + content read — enforced
 *      at the dispatch site via MUTATING_OR_CONTENT_METHODS (server.ts).
 *   3. Registered-project-roots allowlist + realpath descendant check in
 *      EVERY handler below — implemented here.
 *
 * Path handling: `~` is expanded against the DAEMON's $HOME (Studio passes
 * paths verbatim and never resolves them). A repo path must have been
 * registered via `project.open`; every file target is realpath-resolved and
 * confirmed to be a descendant of the registered root, so neither a `..`
 * traversal nor a symlink can escape to `~/.ssh`, `~/.age-identity`, etc.
 */

import { constants as fsConstants } from 'node:fs';
import { open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createLogger } from '@revealui/utils/logger';
import { findNeverBoundOverlap, neverBoundSet, resolveOperatorHome } from './confinement.js';
import { onAgentEnded, onDaemonStarted } from './eviction.js';
import { getDaemonConfig, registerHandler } from './server.js';
import { runGit, type ShellResult } from './vcs.js';

const log = createLogger({ service: 'revdev-daemon/filegit' });

// ---------------------------------------------------------------------------
// Registered project roots
// ---------------------------------------------------------------------------

interface RootEntry {
  real: string;
  agentId: string;
  dev: bigint;
  ino: bigint;
  /** agentIds granted read/write access by the owner via project.grant. */
  grants: Set<string>;
}

/**
 * Inode-keyed root map: `"${dev}:${ino}"` → RootEntry. Module-level by design
 * — the daemon is a singleton (mirrors pruneState in server.ts). A root is
 * recorded under the VERIFIED signer that opened it (project.open is
 * signature-required); a handler rejects any repoPath whose realpath is not
 * registered OR is owned by a different agent (per-agent root scoping —
 * agent A cannot read/mutate a root agent B opened).
 *
 * Keyed by inode (dev+ino) rather than realpath: the inode uniquely identifies
 * the directory regardless of rename or bind-mount, so an ownership binding
 * cannot be circumvented by racing a rename against the `realpath` check.
 */
const registeredRoots = new Map<string, RootEntry>();

/** Derive the canonical map key for a stat result. */
function inodeKey(dev: bigint, ino: bigint): string {
  return `${dev}:${ino}`;
}

/**
 * Remove all roots owned by `agentId` from both the in-memory map and the
 * persisted `project_roots` table. Called when the agent's session ends so
 * terminated agents cannot inherit ownership of paths they opened.
 */
function evictRootsForAgent(agentId: string, db: PGlite): void {
  for (const [key, entry] of registeredRoots) {
    if (entry.agentId === agentId) {
      registeredRoots.delete(key);
    } else {
      // Cascade: strip the evicted agent from any root's grants so terminated
      // agents cannot retain cross-agent access after their session ends.
      entry.grants.delete(agentId);
    }
  }
  // Best-effort persist — the in-memory state is already clean.
  db.query(`DELETE FROM project_roots WHERE agent_id = $1`, [agentId]).catch(() => {});
}

// Register the eviction callback so server.ts can fire it on session.end and
// harness.prune without a circular import (see eviction.ts).
onAgentEnded(evictRootsForAgent);

/** @internal — test seam: clear the allowlist between test cases. */
export function _clearRegisteredRootsForTest(): void {
  registeredRoots.clear();
}

/**
 * @internal — test seam: register an already-realpath'd root directly under
 * `agentId` (defaults to a sentinel for legacy path-resolution tests that do
 * not exercise ownership). Stat-resolves the real inode so the map key matches
 * what requireRoot would compute at runtime.
 */
export async function _addRootForTest(realRoot: string, agentId = '_test'): Promise<void> {
  const s = await stat(realRoot);
  const dev = BigInt(s.dev);
  const ino = BigInt(s.ino);
  registeredRoots.set(inodeKey(dev, ino), { real: realRoot, agentId, dev, ino, grants: new Set() });
}

/**
 * Restore persisted project-root ownership from PGlite on daemon startup.
 * Only restores roots whose owning agent still has an active (not-ended)
 * session — orphaned rows (agent crashed, daemon restarted) are skipped and
 * deleted so a restart cannot land-grab roots from sessions that no longer
 * exist.
 */
export async function restoreProjectRoots(db: PGlite): Promise<void> {
  // Collect orphaned rows (agent session ended or gone).
  const orphans = await db.query<{ dev: string; ino: string }>(
    `SELECT pr.dev, pr.ino
     FROM project_roots pr
     LEFT JOIN agent_sessions s ON s.id = pr.agent_id AND s.ended_at IS NULL
     WHERE s.id IS NULL`,
  );
  if (orphans.rows.length > 0) {
    // Delete them in bulk — orphaned bindings from crashed sessions must not
    // survive a restart (D3: no restart land-grab).
    for (const row of orphans.rows) {
      await db.query(`DELETE FROM project_roots WHERE dev = $1 AND ino = $2`, [row.dev, row.ino]);
    }
  }

  // Restore surviving rows into the in-memory map.
  const rows = await db.query<{
    dev: string;
    ino: string;
    real_path: string;
    agent_id: string;
  }>(
    `SELECT pr.dev, pr.ino, pr.real_path, pr.agent_id
     FROM project_roots pr
     INNER JOIN agent_sessions s ON s.id = pr.agent_id AND s.ended_at IS NULL`,
  );
  // D3 (GAP-326): re-validation below uses neverBoundContext(), which lazily
  // computes from this started daemon's config (getDaemonConfig() is set before
  // this hook fires) — so a restart under a new dataDir is reflected without an
  // explicit reset. Tests pin the context via _setNeverBoundForTest first.
  for (const row of rows.rows) {
    const dev = BigInt(row.dev);
    const ino = BigInt(row.ino);
    // D3 (GAP-326): re-validate every persisted root against D1's checks. A row
    // written before this gate existed — or before the never-bound set grew —
    // may now be a non-repo or overlap a secret path; such a row is EVICTED
    // (deleted + logged), never restored into the serving map, so set growth
    // becomes retroactively protective. The path is the operator's own material
    // and this is the operator's own daemon log, so naming it is not an oracle.
    let evictReason: string | null = null;
    const isRepo = await stat(join(row.real_path, '.git')).then(
      () => true,
      () => false,
    );
    if (!isRepo) {
      evictReason = 'not a git repository';
    } else {
      try {
        assertRootAvoidsNeverBound(row.real_path);
      } catch (e) {
        evictReason = e instanceof Error ? e.message : String(e);
      }
    }
    if (evictReason !== null) {
      log.warn('evicting persisted project root that fails never-bound re-validation', {
        root: row.real_path,
        reason: evictReason,
      });
      await db.query(`DELETE FROM project_roots WHERE dev = $1 AND ino = $2`, [row.dev, row.ino]);
      continue;
    }
    registeredRoots.set(inodeKey(dev, ino), {
      real: row.real_path,
      agentId: row.agent_id,
      dev,
      ino,
      grants: new Set(), // grants are in-memory only; agents re-grant on reconnect
    });
  }
}

// Register the startup hook so server.ts can restore persisted roots on
// startDaemon without a circular import (see eviction.ts).
onDaemonStarted(restoreProjectRoots);

/** @internal — test seam: exercise the realpath descendant resolver. */
export function _resolveInRootForTest(
  repoReal: string,
  filePathRaw: string,
  mustExist: boolean,
): Promise<string> {
  return resolveInRoot(repoReal, filePathRaw, mustExist);
}

/** @internal — test seam: exercise the lexical git-pathspec escape check. */
export function _gitRelPathForTest(repoReal: string, filePathRaw: string): string {
  return gitRelPath(repoReal, filePathRaw);
}

/** @internal — test seam: classify a git config key as exec-bearing or not. */
export function _isExecBearingConfigKeyForTest(key: string, value: string): boolean {
  return isExecBearingConfigKey(key, value);
}

// ---------------------------------------------------------------------------
// Param + path helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function requireStr(v: unknown, name: string): string {
  const s = str(v);
  if (s === null || s.length === 0) throw new Error(`missing required string param: ${name}`);
  return s;
}

/** Expand a leading `~` against the daemon's own $HOME. */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** True when `target` is `root` itself or a descendant of it. */
function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

// ---------------------------------------------------------------------------
// Never-bound secret set at the file layer (GAP-326)
//
// The confinement layer (agent.spawn) refuses to BIND a granted root that
// overlaps the operator's secret set. The SAME set must gate the file.*/git.*
// surface, or a client-owned verified signer can project.open a secret-bearing
// tree — the operator home, ~/.ssh, the passage store — and read it straight
// through file.read with no spawn involved (so confinement never runs). One
// never-bound set (confinement.ts's `neverBoundSet`), imported here and shared
// via `findNeverBoundOverlap` — never a second literal list.
// ---------------------------------------------------------------------------

/**
 * Memoized (operatorHome, never-bound list) for this daemon. Computed lazily on
 * first use — in a running daemon that is during restoreProjectRoots or the
 * first file op, both after getDaemonConfig() is set, so it reflects the active
 * dataDir/home without an explicit reset. Precomputed once thereafter so the D2
 * resolution belt adds no per-call I/O. Tests override it via _setNeverBoundForTest.
 */
let neverBoundCache: { operatorHome: string; list: string[] } | null = null;

function neverBoundContext(): { operatorHome: string; list: string[] } {
  if (neverBoundCache === null) {
    const operatorHome = resolveOperatorHome();
    neverBoundCache = {
      operatorHome,
      list: neverBoundSet(operatorHome, getDaemonConfig().dataDir),
    };
  }
  return neverBoundCache;
}

/**
 * @internal — test seam: pin the never-bound context to a scratch home/dataDir
 * so a test can register an overlapping "secret" tree without touching the real
 * operator home.
 */
export function _setNeverBoundForTest(operatorHome: string, dataDir: string): void {
  const home = resolveOperatorHome(operatorHome);
  neverBoundCache = { operatorHome: home, list: neverBoundSet(home, dataDir) };
}

/** @internal — test seam: drop the pinned/memoized never-bound context. */
export function _resetNeverBoundForTest(): void {
  neverBoundCache = null;
}

/**
 * Coarse CLASS of a never-bound entry, for an error handed back to a possibly
 * hostile project.open/file.* caller. We name the CLASS ("ssh keys"), never the
 * full path — echoing the operator's home layout back would be an oracle. The
 * secret CATEGORIES are public knowledge; a specific home path is not. Zero
 * regex (substring membership only).
 */
function neverBoundClass(entry: string): string {
  if (entry.includes('/.ssh')) return 'ssh keys';
  if (entry.includes('.age-identity')) return 'the age identity';
  if (entry.includes('passage-store')) return 'the credential store';
  if (entry.includes('/.config/gh')) return 'github credentials';
  if (entry.includes('.npmrc')) return 'npm credentials';
  if (entry.includes('/.aws')) return 'aws credentials';
  if (entry.includes('.docker')) return 'docker credentials';
  if (entry.includes('/.claude')) return 'agent credentials';
  if (entry.includes('/mnt/c') || entry.includes('/mnt/e')) return 'a mounted credential volume';
  if (entry.includes('/run/user')) return 'the runtime socket directory';
  return 'daemon secret state';
}

/**
 * D1/D3 root gate (GAP-326): refuse a project root that IS or CONTAINS the
 * operator home, or that overlaps the never-bound secret set in either
 * direction. Same semantics as confinement's `assertGrantedRootBindable`,
 * sharing `findNeverBoundOverlap` + `neverBoundSet`; class-only errors (a root
 * beneath the home, the normal `~/revfleet/<repo>` shape, is NOT refused).
 */
function assertRootAvoidsNeverBound(real: string): void {
  const { operatorHome, list } = neverBoundContext();
  if (real === operatorHome || within(real, operatorHome)) {
    throw new Error(
      'project root is or contains the operator home (it would expose the entire home through file.*)',
    );
  }
  const nb = findNeverBoundOverlap(real, list);
  if (nb !== null) {
    throw new Error(`project root overlaps a never-bound secret path (${neverBoundClass(nb)})`);
  }
}

/**
 * D2 resolution belt (GAP-326): refuse a resolved target that lands on the
 * never-bound set. Defense-in-depth behind D1 — the invariant holds even for a
 * root that came to be registered before this gate existed (a pre-fix persisted
 * row D3 eviction has not reached, or a never-bound entry that grew). One
 * precomputed prefix scan, no added I/O (the caller already realpath'd).
 */
function assertTargetAvoidsNeverBound(target: string): void {
  const nb = findNeverBoundOverlap(target, neverBoundContext().list);
  if (nb !== null) {
    throw new Error(`path resolves onto a never-bound secret path (${neverBoundClass(nb)})`);
  }
}

/**
 * @internal — test seam: exercise the D1/D3 never-bound root gate on an
 * already-realpath'd root (the same check project.open and restoreProjectRoots
 * run). Throws the class-only refusal; returns void on a clean root.
 */
export function _assertRootAvoidsNeverBoundForTest(real: string): void {
  assertRootAvoidsNeverBound(real);
}

/**
 * Resolve a raw repoPath to its realpath and assert it is a root registered by
 * THIS caller (`callerAgentId`). Throws if the path does not exist, was never
 * registered via project.open, OR was registered by a different agent.
 *
 * The "not registered" and "owned by another agent" cases throw the SAME
 * message on purpose — a caller must not be able to probe which roots another
 * agent has opened (no cross-agent existence oracle). The ownership mismatch
 * is logged server-side for debugging.
 */
async function requireRoot(repoPathRaw: string, callerAgentId: string | null): Promise<string> {
  const expanded = expandTilde(repoPathRaw);
  let real: string;
  try {
    real = await realpath(expanded);
  } catch {
    throw new Error(`project root does not exist: ${repoPathRaw}`);
  }
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(real);
  } catch {
    throw new Error(`project root does not exist: ${repoPathRaw}`);
  }
  const key = inodeKey(BigInt(s.dev), BigInt(s.ino));
  const entry = registeredRoots.get(key);
  // `entry.real !== real` guards against inode reuse: if a temp directory is
  // deleted and the kernel reuses its inode for a new directory at a different
  // path, the stored entry's real path won't match the caller's resolved path —
  // we reject rather than authorizing the new path under the old entry.
  const isOwner = callerAgentId !== null && entry !== undefined && entry.agentId === callerAgentId;
  const isGrantee = callerAgentId && entry?.grants.has(callerAgentId);
  if (entry === undefined || entry.real !== real || (!isOwner && !isGrantee)) {
    throw new Error(`project root not registered: ${repoPathRaw} (call project.open first)`);
  }
  return entry.real;
}

/**
 * Resolve a file path against an already-validated repo root, confirming via
 * realpath that it cannot escape the root through `..` or a symlink.
 *
 *  - mustExist=true:  realpath the target itself (read / delete / stat).
 *  - mustExist=false: realpath the PARENT directory (write / create a
 *    possibly-new file), then join the basename — the parent must itself be
 *    a real descendant of the root.
 */
async function resolveInRoot(
  repoReal: string,
  filePathRaw: string,
  mustExist: boolean,
): Promise<string> {
  const expanded = expandTilde(filePathRaw);
  const abs = isAbsolute(expanded) ? expanded : resolve(repoReal, expanded);

  if (mustExist) {
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      throw new Error(`file not found: ${filePathRaw}`);
    }
    if (!within(repoReal, real)) throw new Error(`path escapes project root: ${filePathRaw}`);
    assertTargetAvoidsNeverBound(real);
    return real;
  }

  const parent = dirname(abs);
  let parentReal: string;
  try {
    parentReal = await realpath(parent);
  } catch {
    throw new Error(`parent directory does not exist: ${filePathRaw}`);
  }
  if (!within(repoReal, parentReal)) throw new Error(`path escapes project root: ${filePathRaw}`);
  const target = join(parentReal, basename(abs));
  assertTargetAvoidsNeverBound(target);
  return target;
}

/**
 * Authorize a working directory for a caller: the repo root must be registered
 * and owned-or-granted by `callerAgentId`, and `cwdRaw` must resolve to a real
 * directory at or beneath that root.
 *
 * Exported for `agent.spawn`, which forks a caller-supplied command as the
 * daemon UID. Authentication (the Ed25519 signature gate) proves *who* is
 * asking; this proves they are allowed to run it *there*. Both invariants stay
 * in this module so the spawn surface cannot drift from the file surface.
 */
export async function requireDirInRoot(
  repoPathRaw: string,
  cwdRaw: string | undefined,
  callerAgentId: string | null,
): Promise<string> {
  return (await requireRootAndDir(repoPathRaw, cwdRaw, callerAgentId)).cwd;
}

/**
 * Like `requireDirInRoot`, but returns BOTH the realpath'd granted root and the
 * resolved cwd. `agent.spawn` confinement binds the whole root read-write and
 * then chdirs into the (at-or-beneath) cwd, so it needs both — the root to
 * bind, the cwd to start in. Same authorization; a single realpath+ownership
 * check backs both values so the two surfaces cannot drift.
 */
export async function requireRootAndDir(
  repoPathRaw: string,
  cwdRaw: string | undefined,
  callerAgentId: string | null,
): Promise<{ repoReal: string; cwd: string }> {
  const repoReal = await requireRoot(repoPathRaw, callerAgentId);
  if (cwdRaw === undefined || cwdRaw === '') return { repoReal, cwd: repoReal };

  // mustExist=true realpaths the target itself, so a symlink pointing outside
  // the root resolves before `within()` sees it.
  const real = await resolveInRoot(repoReal, cwdRaw, true);
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(real);
  } catch {
    throw new Error(`cwd does not exist: ${cwdRaw}`);
  }
  if (!s.isDirectory()) throw new Error(`cwd is not a directory: ${cwdRaw}`);
  return { repoReal, cwd: real };
}

/**
 * Lexical repo-relative path for a git pathspec argument. The repo root is
 * already a realpath'd registered root, and git itself confines pathspecs to
 * the work tree, so a lexical `..`/absolute-escape check is sufficient here
 * (no filesystem hit). Always passed after a `--` separator by callers.
 */
function gitRelPath(repoReal: string, filePathRaw: string): string {
  const expanded = expandTilde(filePathRaw);
  const abs = isAbsolute(expanded) ? expanded : resolve(repoReal, expanded);
  const rel = relative(repoReal, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path escapes project root: ${filePathRaw}`);
  }
  return rel;
}

/**
 * Refuse a `file.*` mutation whose resolved target is the repo's `.git`
 * directory or anything inside it. Git internals are reached through the
 * `git.*` RPCs, never `file.*`; permitting a write here is the post-`project.open`
 * config-exec vector: a signed agent could `file.write` `.git/config`
 * `filter.<d>.process=<cmd>` + an in-tree `.gitattributes`, then `git.stageFile`
 * (clean) or a checkout (smudge) fires the filter as the daemon UID. The
 * `filter.*` namespace cannot be `-c`-cleared at runtime, and `assertNoExecConfig`
 * only runs at `project.open`, so a post-open `.git/config` write would otherwise
 * slip past every guard. `repoReal` and `target` are both realpath-resolved by
 * the caller, so this lexical first-segment check is not symlink-foolable.
 */
function assertNotGitInternal(repoReal: string, target: string, filePathRaw: string): void {
  const rel = relative(repoReal, target);
  if (rel === '.git' || rel.split(sep)[0] === '.git') {
    throw new Error(
      `refusing to modify git internals via file.*: ${filePathRaw} resolves into .git/`,
    );
  }
}

/**
 * True when a git config key (already lower-cased by `git config --list`) names
 * an arbitrary-command vector that runs as the daemon UID on a routine read or
 * checkout. A command-line `-c` neutralizes some of these per-spawn, but
 * `filter.*` is a wildcard namespace that `-c` cannot blanket-clear and a hook
 * driver fires regardless — so a repo carrying any of them is refused outright
 * at `project.open` rather than trusted to a per-command flag.
 *
 *   - diff.external                       — external diff program
 *   - filter.<d>.process/.clean/.smudge   — content filter driver (clean on add,
 *                                            smudge/process on checkout)
 *   - <section>.textconv                  — diff textconv driver
 *   - core.fsmonitor / core.sshCommand    — fsmonitor + ssh command
 *   - core.pager                          — pager command
 *   - remote.<r>.uploadpack/.receivepack  — remote-side program override
 *   - url.<u>.insteadOf/.pushInsteadOf    — URL rewrite (pairs with ext::/ssh)
 *   - alias.<a> whose value starts with ! — shell alias
 *
 * Value is consulted only for aliases (the `!` shell-escape marker); for every
 * other key the presence of the key is itself the finding.
 */
function isExecBearingConfigKey(key: string, value: string): boolean {
  if (
    key === 'diff.external' ||
    key === 'core.fsmonitor' ||
    key === 'core.sshcommand' ||
    key === 'core.pager'
  ) {
    return true;
  }
  if (
    key.startsWith('filter.') &&
    (key.endsWith('.process') || key.endsWith('.clean') || key.endsWith('.smudge'))
  ) {
    return true;
  }
  if (key.endsWith('.textconv')) return true;
  if (key.startsWith('remote.') && (key.endsWith('.uploadpack') || key.endsWith('.receivepack'))) {
    return true;
  }
  if (key.startsWith('url.') && (key.endsWith('.insteadof') || key.endsWith('.pushinsteadof'))) {
    return true;
  }
  if (key.startsWith('alias.') && value.startsWith('!')) return true;
  return false;
}

/**
 * List a repo's effective local git config as lower-cased `[key, value]` pairs.
 * `git config --list` never invokes a filter/diff/hook driver, so listing the
 * config of an untrusted repo is safe; it runs under the hardened env from
 * vcs.ts. `-z` is NUL-delimited so a multi-line value can't be confused with an
 * entry boundary; within an entry the key and value split on the first `\n`. A
 * config git itself cannot parse (r.ok === false) yields `[]` — it can't drive
 * an exploit either, so "unreadable" and "empty" are treated the same.
 */
async function localConfigEntries(repoReal: string): Promise<Array<[string, string]>> {
  const r = await runGit(['config', '--list', '--local', '-z'], repoReal);
  if (!r.ok) return [];
  const entries: Array<[string, string]> = [];
  for (const entry of r.stdout.split('\0')) {
    if (entry.length === 0) continue;
    const nl = entry.indexOf('\n');
    const key = (nl === -1 ? entry : entry.slice(0, nl)).toLowerCase();
    const value = nl === -1 ? '' : entry.slice(nl + 1);
    entries.push([key, value]);
  }
  return entries;
}

/**
 * Refuse to register a repo whose config carries any exec-bearing key. Runs once
 * at `project.open` — the trust boundary for a third-party repo.
 */
async function assertNoExecConfig(repoReal: string): Promise<void> {
  for (const [key, value] of await localConfigEntries(repoReal)) {
    if (isExecBearingConfigKey(key, value)) {
      throw new Error(
        `refusing to open repo: .git/config sets exec-bearing key "${key}" ` +
          '(arbitrary-command vector; remove it before opening this repo)',
      );
    }
  }
}

/**
 * Refuse a worktree-materializing op (`git add` → `clean`, checkout/restore →
 * `smudge`/`process`) when the repo defines a `filter.<d>.process/.clean/.smudge`
 * driver. This is the residual `project.open`'s open-time scan can't cover alone:
 * unlike diff.external/textconv (runtime-neutralized by `--no-ext-diff`/
 * `--no-textconv`) and hooks (`core.hooksPath=/dev/null`), a content filter
 * CANNOT be `-c`-cleared per spawn, so the only safe response to a repo that
 * carries one is to refuse the op. The `.git/`-write block keeps a filter out of
 * a daemon-opened repo; this is the runtime backstop for a config planted by any
 * other route. Narrower than `assertNoExecConfig` on purpose — `add`/checkout do
 * not run diff.external/textconv, so those stay neutralize-and-proceed.
 */
async function assertNoFilterDriver(repoReal: string): Promise<void> {
  for (const [key] of await localConfigEntries(repoReal)) {
    if (
      key.startsWith('filter.') &&
      (key.endsWith('.process') || key.endsWith('.clean') || key.endsWith('.smudge'))
    ) {
      throw new Error(
        `refusing op: .git/config sets a content filter driver "${key}" ` +
          '(arbitrary-command vector that cannot be neutralized per-spawn; remove it)',
      );
    }
  }
}

/**
 * Wrap content in an inline-or-tooLarge envelope. The inbound maxLineBytes
 * cap guards request frames only; a content-returning READ would otherwise
 * serialize an unbounded file into a single response frame. Above the cap the
 * caller gets `{ tooLarge: true, bytes }` and falls back to a streamed view.
 */
function inlineContent(
  buf: Buffer,
): { content: string; bytes: number } | { tooLarge: true; bytes: number } {
  const bytes = buf.byteLength;
  if (bytes > getDaemonConfig().maxInlineReadBytes) return { tooLarge: true, bytes };
  return { content: buf.toString('utf8'), bytes };
}

/** Normalize a ShellResult from a mutating git op into a success/error shape. */
function gitOutcome(r: ShellResult, what: string): Record<string, unknown> {
  if (!r.ok) return { success: false, error: r.stderr || `${what} failed`, code: r.code };
  return { success: true, stdout: r.stdout };
}

// ---------------------------------------------------------------------------
// project.*
// ---------------------------------------------------------------------------

registerHandler('project.open', async (params, db, ctx) => {
  const repoPathRaw = requireStr(params.repoPath, 'repoPath');
  const expanded = expandTilde(repoPathRaw);
  let real: string;
  try {
    real = await realpath(expanded);
  } catch {
    throw new Error(`project root does not exist: ${repoPathRaw}`);
  }
  // D1 (GAP-326): confirm it is actually a git repository. Registering a non-repo
  // root would let file.* operate on an arbitrary directory tree — the comment
  // here has claimed this policy since the surface shipped; the code now enforces
  // it. A non-repo root also skips assertNoExecConfig below, so rejecting it
  // closes both gaps at once. A future non-repo need arrives as a new,
  // separately-reviewed method — never by silently widening project.open.
  const isRepo = await stat(join(real, '.git')).then(
    () => true,
    () => false,
  );
  if (!isRepo) {
    throw new Error(`project root is not a git repository: ${repoPathRaw}`);
  }
  // D1 (GAP-326): refuse a root that overlaps the never-bound secret set (in
  // either direction) or the operator home, BEFORE any registration side effect.
  // Without this a client-owned verified signer could project.open("~") or
  // project.open("~/.ssh") and read secrets straight through file.read — no spawn,
  // so the confinement layer never runs. Same never-bound set the spawn side
  // enforces (confinement.ts), imported — never a second copy.
  assertRootAvoidsNeverBound(real);
  if (ctx.agentId === null) {
    // Unreachable in practice: project.open is in MUTATING_OR_CONTENT_METHODS,
    // so the dispatch signature gate binds ctx.agentId to the verified signer
    // before this handler runs. Belt-and-suspenders so a future exemption
    // change can never register an unowned (globally-usable) root.
    throw new Error('project.open requires a verified signer identity');
  }
  // D2: daemon-minted identities may never own filesystem roots. Root ownership
  // requires a client-owned, per-request-signed identity so the isolation
  // guarantee rests on cryptographic proof rather than socket trust alone.
  const originRow = await db.query<{ key_origin: string }>(
    `SELECT key_origin FROM agent_identity WHERE agent_id = $1`,
    [ctx.agentId],
  );
  if (originRow.rows[0]?.key_origin === 'daemon') {
    throw new Error(
      'project.open: daemon-minted identities may not own filesystem roots — use a client-owned (Studio) identity',
    );
  }
  // Refuse to register a git repo whose config carries an exec-bearing key.
  // project.open is the trust boundary for a third-party repo: without this a
  // routine `git.diffFile`/`git.stageFile`/checkout would run attacker code as
  // the daemon UID (e.g. exfil ~/.age-identity/keys.txt). Done BEFORE adding to
  // registeredRoots so a refused repo is never usable by file.*/git.*. isRepo is
  // guaranteed true here (non-repo roots are rejected by D1 above).
  await assertNoExecConfig(real);
  // Stat to get the canonical inode key.
  const s = await stat(real);
  const dev = BigInt(s.dev);
  const ino = BigInt(s.ino);
  const key = inodeKey(dev, ino);
  // Nested-root containment (B6 item 3): reject a root that is an ancestor or
  // descendant of a different agent's owned root. A parent-root owner reaches
  // a child root's files via within(); a child-root opener would inherit access
  // to the parent agent's tree via requireRoot + within(). Both directions are
  // rejected here before any registration occurs.
  for (const [, entry] of registeredRoots) {
    if (entry.agentId === ctx.agentId) continue;
    if (within(entry.real, real) || within(real, entry.real)) {
      throw new Error(
        `project root conflict: ${repoPathRaw} overlaps with a root owned by another agent`,
      );
    }
  }
  registeredRoots.set(key, { real, agentId: ctx.agentId, dev, ino, grants: new Set() });
  // Persist to project_roots (D3): UNIQUE(dev,ino) — same agent re-opening is
  // a no-op update; a different agent would have been rejected above, so the
  // conflict update is safe.
  await db.query(
    `INSERT INTO project_roots (dev, ino, real_path, agent_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (dev, ino) DO UPDATE SET real_path = EXCLUDED.real_path, agent_id = EXCLUDED.agent_id, registered_at = NOW()`,
    [dev, ino, real, ctx.agentId],
  );
  return { success: true, root: real, isGitRepo: isRepo };
});

/**
 * Look up a root entry and verify the caller is the OWNER (not merely a
 * grantee). Used by project.grant / project.revoke so only the opener can
 * mutate the grant list.
 */
async function requireOwnerEntry(
  repoPathRaw: string,
  callerAgentId: string | null,
): Promise<RootEntry> {
  const expanded = expandTilde(repoPathRaw);
  let real: string;
  try {
    real = await realpath(expanded);
  } catch {
    throw new Error(`project root does not exist: ${repoPathRaw}`);
  }
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(real);
  } catch {
    throw new Error(`project root does not exist: ${repoPathRaw}`);
  }
  const key = inodeKey(BigInt(s.dev), BigInt(s.ino));
  const entry = registeredRoots.get(key);
  if (
    entry === undefined ||
    entry.real !== real ||
    callerAgentId === null ||
    entry.agentId !== callerAgentId
  ) {
    throw new Error(
      `project root not owned by caller: ${repoPathRaw} (only the owner may grant/revoke access)`,
    );
  }
  return entry;
}

registerHandler('project.grant', async (params, _db, ctx) => {
  const repoPathRaw = requireStr(params.repoPath, 'repoPath');
  const granteeAgentId = requireStr(params.granteeAgentId, 'granteeAgentId');
  const entry = await requireOwnerEntry(repoPathRaw, ctx.agentId);
  entry.grants.add(granteeAgentId);
  return { granted: granteeAgentId, root: entry.real };
});

/**
 * Revoke a grantee's access to a root.
 *
 * NOT a kill-switch. This blocks FUTURE operations, including `agent.spawn`.
 * PTY processes the grantee already spawned keep running: they are keyed to the
 * spawning `ownerAgentId`, not to an ongoing grant, and survive until they exit
 * or the grantee's session ends (see the eviction cascade above). To stop live
 * work, end the grantee's session.
 */
registerHandler('project.revoke', async (params, _db, ctx) => {
  const repoPathRaw = requireStr(params.repoPath, 'repoPath');
  const granteeAgentId = requireStr(params.granteeAgentId, 'granteeAgentId');
  const entry = await requireOwnerEntry(repoPathRaw, ctx.agentId);
  entry.grants.delete(granteeAgentId);
  return { revoked: granteeAgentId, root: entry.real };
});

// ---------------------------------------------------------------------------
// file.*
// ---------------------------------------------------------------------------

registerHandler('file.read', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const target = await resolveInRoot(repoReal, requireStr(params.filePath, 'filePath'), true);
  const buf = await readFile(target);
  return inlineContent(buf);
});

registerHandler('file.write', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const filePathRaw = requireStr(params.filePath, 'filePath');
  const target = await resolveInRoot(repoReal, filePathRaw, false);
  assertNotGitInternal(repoReal, target, filePathRaw);
  const content = str(params.content) ?? '';
  // Open with O_NOFOLLOW so a symlink swapped in at the FINAL component between
  // resolveInRoot's parent-realpath check and the write (leaf TOCTOU) is
  // refused (ELOOP) — a write can't be redirected outside the registered root.
  const handle = await open(
    target,
    // eslint-disable-next-line no-bitwise
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  return { success: true, bytes: Buffer.byteLength(content, 'utf8') };
});

registerHandler('file.delete', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const filePathRaw = requireStr(params.filePath, 'filePath');
  const target = await resolveInRoot(repoReal, filePathRaw, true);
  assertNotGitInternal(repoReal, target, filePathRaw);
  await unlink(target);
  return { success: true };
});

registerHandler('file.stat', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const target = await resolveInRoot(repoReal, requireStr(params.filePath, 'filePath'), false);
  try {
    const s = await stat(target);
    return {
      exists: true,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  } catch {
    return { exists: false };
  }
});

// ---------------------------------------------------------------------------
// git.* — reads
// ---------------------------------------------------------------------------

registerHandler('git.status', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const r = await runGit(['status', '--porcelain=v1', '--branch'], repoReal);
  if (!r.ok) return { success: false, error: r.stderr || 'git status failed' };
  let branch: string | null = null;
  const files: Array<{ status: string; path: string }> = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      let head = line.slice(3);
      const dots = head.indexOf('...');
      if (dots >= 0) head = head.slice(0, dots);
      const space = head.indexOf(' ');
      if (space >= 0) head = head.slice(0, space);
      branch = head;
      continue;
    }
    files.push({ status: line.slice(0, 2), path: line.slice(3) });
  }
  return { success: true, branch, files, clean: files.length === 0 };
});

registerHandler('git.diffFile', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const rel = gitRelPath(repoReal, requireStr(params.filePath, 'filePath'));
  // --no-ext-diff / --no-textconv neutralize a diff.external command or a
  // textconv driver (both arbitrary-command vectors) for THIS spawn without
  // breaking the diff — unlike `-c diff.external=`, which makes git try to exec
  // the empty string and abort the diff. The config-set forms are also refused
  // at project.open (assertNoExecConfig); this is the run-time backstop.
  const args = ['diff', '--no-ext-diff', '--no-textconv'];
  if (params.staged === true) args.push('--cached');
  args.push('--', rel);
  const r = await runGit(args, repoReal);
  if (!r.ok) return { success: false, error: r.stderr || 'git diff failed' };
  return { success: true, diff: r.stdout };
});

registerHandler('git.diffContent', async (params, _db, ctx) => {
  // The working-tree ("after") content for a diff view. Read directly off
  // ext4 (untrimmed, full fidelity) rather than via `git show`.
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const target = await resolveInRoot(repoReal, requireStr(params.filePath, 'filePath'), true);
  const buf = await readFile(target);
  return inlineContent(buf);
});

registerHandler('git.readBlobAtHead', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const rel = gitRelPath(repoReal, requireStr(params.filePath, 'filePath'));
  // NOTE: runGit trims trailing whitespace on stdout, so a blob's final
  // newline is not preserved here. Acceptable for the read-only "committed
  // version" diff pane; full-fidelity working-tree content comes from
  // file.read / git.diffContent (untrimmed fs reads).
  const r = await runGit(['show', `HEAD:${rel}`], repoReal);
  if (!r.ok) return { success: false, error: r.stderr || 'git show HEAD failed' };
  return { success: true, ...inlineContent(Buffer.from(r.stdout, 'utf8')) };
});

registerHandler('git.readBlobAtIndex', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const rel = gitRelPath(repoReal, requireStr(params.filePath, 'filePath'));
  const r = await runGit(['show', `:${rel}`], repoReal);
  if (!r.ok) return { success: false, error: r.stderr || 'git show :index failed' };
  return { success: true, ...inlineContent(Buffer.from(r.stdout, 'utf8')) };
});

registerHandler('git.listBranches', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const r = await runGit(['branch', '--format=%(refname:short)'], repoReal);
  if (!r.ok) return { success: false, error: r.stderr || 'git branch failed' };
  const branches = r.stdout.split('\n').filter(Boolean);
  const cur = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoReal);
  return { success: true, branches, current: cur.ok ? cur.stdout : null };
});

registerHandler('git.log', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const limit = typeof params.limit === 'number' ? Math.max(1, Math.floor(params.limit)) : 50;
  // %x1f = ASCII unit separator, unambiguous against any commit subject text.
  // %aI = author date ISO-8601 (display); %at = author date as a unix timestamp
  // (integer seconds, what UI clients sort/format with).
  const r = await runGit(
    ['log', '--pretty=format:%H%x1f%an%x1f%aI%x1f%at%x1f%s', '-n', String(limit)],
    repoReal,
  );
  if (!r.ok) {
    // An empty repo (no commits yet) is not an error for the editor.
    if (r.stderr.includes('does not have any commits')) return { success: true, commits: [] };
    return { success: false, error: r.stderr || 'git log failed' };
  }
  const commits = r.stdout
    ? r.stdout.split('\n').map((l) => {
        const [hash, author, date, at, subject] = l.split('\x1f');
        return { hash, author, date, timestamp: Number(at), subject };
      })
    : [];
  return { success: true, commits };
});

// ---------------------------------------------------------------------------
// git.* — mutations
// ---------------------------------------------------------------------------

registerHandler('git.stageFile', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  // Re-scan config right before the op: `git add` runs a `filter.<d>.clean`
  // driver, which the per-spawn `-c` flags cannot neutralize. project.open's
  // open-time scan + the .git/ write block already gate the daemon route, so
  // this is defense in depth against a config planted by any other route.
  await assertNoFilterDriver(repoReal);
  const rel = gitRelPath(repoReal, requireStr(params.filePath, 'filePath'));
  return gitOutcome(await runGit(['add', '--', rel], repoReal), 'git add');
});

registerHandler('git.unstageFile', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const rel = gitRelPath(repoReal, requireStr(params.filePath, 'filePath'));
  return gitOutcome(
    await runGit(['restore', '--staged', '--', rel], repoReal),
    'git restore --staged',
  );
});

registerHandler('git.discardFile', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  // `git restore` re-materializes the working-tree copy → runs a `smudge`
  // filter; re-scan config first (defense in depth, see git.stageFile).
  await assertNoFilterDriver(repoReal);
  const rel = gitRelPath(repoReal, requireStr(params.filePath, 'filePath'));
  // Restore the working-tree copy from the index (discard unstaged edits).
  return gitOutcome(await runGit(['restore', '--', rel], repoReal), 'git restore');
});

registerHandler('git.createBranch', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const name = requireStr(params.name, 'name');
  // `--` so a name/base that slipped past validation can't be read as a flag
  // (defense in depth; schema's gitRefArg already rejects a leading '-').
  const args = ['branch', '--', name];
  const base = str(params.baseBranch);
  if (base) args.push(base);
  return gitOutcome(await runGit(args, repoReal), 'git branch');
});

registerHandler('git.switchBranch', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  // A checkout runs a `filter.<d>.smudge`/`process` driver on the new tree;
  // re-scan config first (defense in depth, see git.stageFile).
  await assertNoFilterDriver(repoReal);
  const name = requireStr(params.name, 'name');
  return gitOutcome(await runGit(['switch', '--', name], repoReal), 'git switch');
});

registerHandler('git.deleteBranch', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const name = requireStr(params.name, 'name');
  const flag = params.force === true ? '-D' : '-d';
  return gitOutcome(await runGit(['branch', flag, '--', name], repoReal), 'git branch -d');
});

registerHandler('git.commit', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const message = requireStr(params.message, 'message');
  const commit = await runGit(['commit', '-m', message], repoReal);
  if (!commit.ok) return { success: false, error: commit.stderr || 'git commit failed' };
  // Resolve the new HEAD so callers get the created commit's SHA (the editor
  // surfaces the short SHA after a commit).
  const head = await runGit(['rev-parse', 'HEAD'], repoReal);
  const sha = head.ok ? head.stdout : '';
  return { success: true, sha, shortSha: sha.slice(0, 7), stdout: commit.stdout };
});

registerHandler('git.push', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const args = ['push'];
  const remote = str(params.remote);
  const branch = str(params.branch);
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  return gitOutcome(await runGit(args, repoReal), 'git push');
});

registerHandler('git.pull', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const args = ['pull'];
  const remote = str(params.remote);
  const branch = str(params.branch);
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  return gitOutcome(await runGit(args, repoReal), 'git pull');
});

// ---------------------------------------------------------------------------
// worktree.* — mutations (moved here from vcs.ts for the B-WT fix)
//
// `git worktree add/remove` shells out as the daemon UID, so — exactly like the
// git.* mutations above — these MUST sit behind the two barriers vcs.ts could
// not provide:
//   1. The dispatch signature gate (MUTATING_OR_CONTENT_METHODS / signing.rs::
//      requires_signature) — binds ctx.agentId to the VERIFIED signer. In vcs.ts
//      these were absent from the gate, so an UNSIGNED host process could
//      session.register a bare identity and drive `git worktree add` as the
//      daemon UID — the B-WT unsigned-RCE blocker.
//   2. requireRoot(repoPath, ctx.agentId) — the base repo must have been
//      project.open'd by THIS agent (project.open already ran assertNoExecConfig
//      on it). The worktree path is daemon-derived (a deterministic sibling of
//      the realpath'd root), NEVER the caller's free-form params.path, so it is
//      attacker-uncontrollable. The legacy handler shelled into a DB-`task` cwd
//      with a caller-supplied path — both dropped here.
// worktree.list (read-only registry view) stays in vcs.ts.
// ---------------------------------------------------------------------------

/**
 * Reject an argument git would read as an option (leading '-'). `branch` and
 * `baseBranch` reach `git worktree add` in option position (a `--` separator is
 * not accepted before the new-branch/commit-ish there), so the value itself
 * must be guarded — mirrors the leading-'-' intent of git.createBranch's `--`.
 */
function assertNotGitOption(value: string, name: string): void {
  if (value.startsWith('-')) {
    throw new Error(`invalid ${name}: must not start with '-' (option injection)`);
  }
}

/**
 * Deterministic, attacker-uncontrollable worktree path: a sibling of the
 * realpath'd registered root named `<repo>-<branch>`, with branch slashes folded
 * to dashes (no regex). Used by BOTH create and remove so the git target is
 * identical and is never derived from caller input.
 */
function worktreePathFor(repoReal: string, branch: string): string {
  return join(dirname(repoReal), `${basename(repoReal)}-${branch.split('/').join('-')}`);
}

registerHandler('worktree.create', async (params, db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  // requireRoot guarantees a non-null owner === ctx.agentId; re-assert for the
  // type narrowing + belt-and-suspenders (mirrors project.open).
  const agentId = ctx.agentId;
  if (agentId === null) throw new Error('worktree.create requires a verified signer identity');
  const branch = requireStr(params.branch, 'branch');
  assertNotGitOption(branch, 'branch');
  const baseBranch = str(params.baseBranch) ?? 'main';
  assertNotGitOption(baseBranch, 'baseBranch');
  // `git worktree add` checks out the new tree → runs a filter.<d>.smudge/process
  // driver, which cannot be -c-cleared per spawn. Refuse a base repo carrying one
  // (same backstop as git.switchBranch/git.stageFile).
  await assertNoFilterDriver(repoReal);
  const worktreePath = worktreePathFor(repoReal, branch);
  const result = await runGit(
    ['worktree', 'add', '-b', branch, worktreePath, baseBranch],
    repoReal,
  );
  if (!result.ok) {
    return { success: false, error: result.stderr || 'git worktree add failed' };
  }
  await db.query(
    `INSERT INTO worktrees (agent_id, branch, worktree_path, base_branch, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (agent_id) DO UPDATE SET
       branch = EXCLUDED.branch,
       worktree_path = EXCLUDED.worktree_path,
       base_branch = EXCLUDED.base_branch,
       status = 'active'`,
    [agentId, branch, worktreePath, baseBranch],
  );
  return { success: true, branch, worktreePath, baseBranch };
});

registerHandler('worktree.remove', async (params, db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'), ctx.agentId);
  const agentId = ctx.agentId;
  if (agentId === null) throw new Error('worktree.remove requires a verified signer identity');
  const branch = requireStr(params.branch, 'branch');
  assertNotGitOption(branch, 'branch');
  const row = await db.query<{ worktree_path: string }>(
    `SELECT worktree_path FROM worktrees
     WHERE agent_id = $1 AND branch = $2 AND status = 'active'`,
    [agentId, branch],
  );
  if (!row.rows[0]?.worktree_path) {
    return { success: false, error: `No active worktree for branch ${branch}` };
  }
  // Recompute the path from (realpath'd root, branch) rather than trust the
  // stored string, so the git target stays attacker-uncontrollable.
  const worktreePath = worktreePathFor(repoReal, branch);
  const result = await runGit(['worktree', 'remove', worktreePath], repoReal);
  if (!result.ok) {
    return { success: false, error: result.stderr || 'git worktree remove failed' };
  }
  await db.query(`UPDATE worktrees SET status = 'removed' WHERE agent_id = $1 AND branch = $2`, [
    agentId,
    branch,
  ]);
  return { success: true, branch, worktreePath };
});
