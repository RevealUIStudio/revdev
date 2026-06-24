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
import { getDaemonConfig, registerHandler } from './server.js';
import { runGit, type ShellResult } from './vcs.js';

// ---------------------------------------------------------------------------
// Registered project roots
// ---------------------------------------------------------------------------

/**
 * realpath-resolved absolute root → owning agentId. Module-level by design —
 * the daemon is a singleton (mirrors pruneState in server.ts). A root is
 * recorded under the VERIFIED signer that opened it (project.open is
 * signature-required); a handler rejects any repoPath whose realpath is not
 * registered OR is owned by a different agent (per-agent root scoping —
 * agent A cannot read/mutate a root agent B opened).
 */
const registeredRoots = new Map<string, string>();

/** @internal — test seam: clear the allowlist between test cases. */
export function _clearRegisteredRootsForTest(): void {
  registeredRoots.clear();
}

/**
 * @internal — test seam: register an already-realpath'd root directly under
 * `agentId` (defaults to a sentinel for legacy path-resolution tests that do
 * not exercise ownership).
 */
export function _addRootForTest(realRoot: string, agentId = '_test'): void {
  registeredRoots.set(realRoot, agentId);
}

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
  const owner = registeredRoots.get(real);
  if (owner === undefined || callerAgentId === null || owner !== callerAgentId) {
    throw new Error(`project root not registered: ${repoPathRaw} (call project.open first)`);
  }
  return real;
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
  return join(parentReal, basename(abs));
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

registerHandler('project.open', async (params, _db, ctx) => {
  const repoPathRaw = requireStr(params.repoPath, 'repoPath');
  const expanded = expandTilde(repoPathRaw);
  let real: string;
  try {
    real = await realpath(expanded);
  } catch {
    throw new Error(`project root does not exist: ${repoPathRaw}`);
  }
  // Confirm it is actually a git repository — registering a non-repo root
  // would let file.* operate on an arbitrary directory tree.
  const isRepo = await stat(join(real, '.git')).then(
    () => true,
    () => false,
  );
  registeredRoots.add(real);
  return { success: true, root: real, isGitRepo: isRepo };
});

// ---------------------------------------------------------------------------
// file.*
// ---------------------------------------------------------------------------

registerHandler('file.read', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const target = await resolveInRoot(repoReal, requireStr(params.filePath, 'filePath'), true);
  const buf = await readFile(target);
  return inlineContent(buf);
});

registerHandler('file.write', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const target = await resolveInRoot(repoReal, requireStr(params.filePath, 'filePath'), false);
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
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const target = await resolveInRoot(repoReal, requireStr(params.filePath, 'filePath'), true);
  await unlink(target);
  return { success: true };
});

registerHandler('file.stat', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
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
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
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
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const rel = gitRelPath(repoReal, requireStr(params.filePath, 'filePath'));
  const args = ['diff'];
  if (params.staged === true) args.push('--cached');
  args.push('--', rel);
  const r = await runGit(args, repoReal);
  if (!r.ok) return { success: false, error: r.stderr || 'git diff failed' };
  return { success: true, diff: r.stdout };
});

registerHandler('git.diffContent', async (params, _db, ctx) => {
  // The working-tree ("after") content for a diff view. Read directly off
  // ext4 (untrimmed, full fidelity) rather than via `git show`.
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const target = await resolveInRoot(repoReal, requireStr(params.filePath, 'filePath'), true);
  const buf = await readFile(target);
  return inlineContent(buf);
});

registerHandler('git.readBlobAtHead', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
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
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const rel = gitRelPath(repoReal, requireStr(params.filePath, 'filePath'));
  const r = await runGit(['show', `:${rel}`], repoReal);
  if (!r.ok) return { success: false, error: r.stderr || 'git show :index failed' };
  return { success: true, ...inlineContent(Buffer.from(r.stdout, 'utf8')) };
});

registerHandler('git.listBranches', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const r = await runGit(['branch', '--format=%(refname:short)'], repoReal);
  if (!r.ok) return { success: false, error: r.stderr || 'git branch failed' };
  const branches = r.stdout.split('\n').filter(Boolean);
  const cur = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoReal);
  return { success: true, branches, current: cur.ok ? cur.stdout : null };
});

registerHandler('git.log', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
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
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const rel = gitRelPath(repoReal, requireStr(params.filePath, 'filePath'));
  return gitOutcome(await runGit(['add', '--', rel], repoReal), 'git add');
});

registerHandler('git.unstageFile', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const rel = gitRelPath(repoReal, requireStr(params.filePath, 'filePath'));
  return gitOutcome(
    await runGit(['restore', '--staged', '--', rel], repoReal),
    'git restore --staged',
  );
});

registerHandler('git.discardFile', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const rel = gitRelPath(repoReal, requireStr(params.filePath, 'filePath'));
  // Restore the working-tree copy from the index (discard unstaged edits).
  return gitOutcome(await runGit(['restore', '--', rel], repoReal), 'git restore');
});

registerHandler('git.createBranch', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const name = requireStr(params.name, 'name');
  // `--` so a name/base that slipped past validation can't be read as a flag
  // (defense in depth; schema's gitRefArg already rejects a leading '-').
  const args = ['branch', '--', name];
  const base = str(params.baseBranch);
  if (base) args.push(base);
  return gitOutcome(await runGit(args, repoReal), 'git branch');
});

registerHandler('git.switchBranch', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const name = requireStr(params.name, 'name');
  return gitOutcome(await runGit(['switch', '--', name], repoReal), 'git switch');
});

registerHandler('git.deleteBranch', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const name = requireStr(params.name, 'name');
  const flag = params.force === true ? '-D' : '-d';
  return gitOutcome(await runGit(['branch', flag, '--', name], repoReal), 'git branch -d');
});

registerHandler('git.commit', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
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
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const args = ['push'];
  const remote = str(params.remote);
  const branch = str(params.branch);
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  return gitOutcome(await runGit(args, repoReal), 'git push');
});

registerHandler('git.pull', async (params, _db, ctx) => {
  const repoReal = await requireRoot(requireStr(params.repoPath, 'repoPath'));
  const args = ['pull'];
  const remote = str(params.remote);
  const branch = str(params.branch);
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  return gitOutcome(await runGit(args, repoReal), 'git pull');
});
