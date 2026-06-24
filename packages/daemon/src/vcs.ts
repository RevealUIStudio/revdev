/**
 * VCS handlers — git worktree management and merge-request tracking.
 *
 * Worktrees are real: we shell out to `git worktree add/remove` in the
 * agent's working directory. Merge requests are tracked in the
 * `merge_requests` table; actual PR creation is left to the client
 * (agents call `gh pr create` themselves and then update status here).
 *
 * Reliability: every git spawn is bounded by `DAEMON_DEFAULTS.gitTimeoutMs`
 * (default 60 s, env-overridable via REVDEV_DAEMON_GIT_TIMEOUT_MS) AND
 * aborted on daemon shutdown via the shared shutdown signal from
 * server.ts. Without this, a runaway git command (credential prompt on
 * a private base branch, corrupt object DB, hung remote) would hold
 * the daemon socket forever — SIGTERM to the daemon does not propagate
 * to orphaned children. On timeout or shutdown abort, the child receives
 * SIGTERM via spawn's native AbortSignal handling and the handler
 * returns a structured error response.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_DEFAULTS } from './config.js';
import { getShutdownSignal, registerHandler } from './server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  /** True if the child was aborted before clean exit (timeout or shutdown). */
  aborted?: boolean;
  /** Disambiguates timeout vs caller/shutdown abort. Only set when aborted. */
  abortReason?: 'timeout' | 'shutdown';
}

export interface RunChildOptions {
  cwd: string;
  /** Per-call timeout. Defaults to DAEMON_DEFAULTS.gitTimeoutMs (60 s). */
  timeoutMs?: number;
  /**
   * Optional external signal — combined with the daemon shutdown signal
   * and the timeout via `AbortSignal.any` so the spawned child gets
   * SIGTERM if any source aborts.
   */
  externalSignal?: AbortSignal;
  /**
   * Environment for the child. When omitted the child inherits the parent
   * process environment (Node's default). `runGit` always supplies a hardened
   * env (see `gitHardenedEnv`); only the generic test seam leaves it unset.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn a child process with timeout + shutdown awareness. Returns a
 * structured ShellResult; never throws. On abort, the spawned child is
 * SIGTERM'd via Node's native AbortSignal handling on the spawn options.
 *
 * Exported for testing — production code uses `runGit` below.
 */
export function runChild(
  command: string,
  args: string[],
  opts: RunChildOptions,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? DAEMON_DEFAULTS.gitTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const shutdownSignal = getShutdownSignal();

    const sources: AbortSignal[] = [timeoutSignal];
    if (shutdownSignal) sources.push(shutdownSignal);
    if (opts.externalSignal) sources.push(opts.externalSignal);
    // sources always contains at least timeoutSignal, so AbortSignal.any
    // is well-defined; the single-source branch avoids one allocation.
    const signal = sources.length > 1 ? AbortSignal.any(sources) : timeoutSignal;

    let aborted = false;
    let abortReason: 'timeout' | 'shutdown' | undefined;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      // Timeout takes precedence in disambiguation. External signals are
      // reported as "shutdown" — caller-driven cancellation semantically
      // matches shutdown for our purposes (the child gets SIGTERM either
      // way; the disambiguation is only for the human-readable message).
      abortReason = timeoutSignal.aborted ? 'timeout' : 'shutdown';
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      // Only override the environment when a caller supplies one (runGit does;
      // the generic runChild test seam does not). Passing `undefined` here would
      // make spawn use an EMPTY env on some Node versions, so branch on it.
      ...(opts.env ? { env: opts.env } : {}),
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const buildAbortedResult = (code: number): ShellResult => {
      const reason = abortReason ?? 'shutdown';
      const message =
        reason === 'timeout'
          ? `${command} timed out after ${timeoutMs}ms`
          : `${command} aborted by daemon shutdown`;
      return {
        ok: false,
        stdout: stdout.trim(),
        stderr: stderr.trim() || message,
        code,
        aborted: true,
        abortReason: reason,
      };
    };

    child.on('close', (code) => {
      if (aborted) {
        resolve(buildAbortedResult(code ?? -1));
        return;
      }
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: code ?? -1,
      });
    });

    child.on('error', (err) => {
      // spawn() emits AbortError on signal abort; the close handler may or
      // may not also fire depending on whether the child started. Resolve
      // here for the abort-before-spawn case; close handler is no-op'd
      // because Promises only resolve once.
      if (aborted || (err as NodeJS.ErrnoException).name === 'AbortError') {
        resolve(buildAbortedResult(-1));
        return;
      }
      resolve({ ok: false, stdout: '', stderr: err.message, code: -1 });
    });
  });
}

/**
 * Hardening flags prepended to EVERY git spawn. The daemon runs git against
 * project repos as its own UID, so any command git would execute on its
 * behalf is a shared-UID RCE past the traversal confinement. A command-line
 * `-c` overrides repo/global config, so these are authoritative:
 *   - core.hooksPath=/dev/null — don't run a repo's hooks (a hook an agent
 *     writes into its own root would otherwise execute as the daemon).
 *   - protocol.ext.allow=never — block the `ext::` transport (arbitrary cmd).
 *   - core.fsmonitor= — disable the fsmonitor hook (runs a command).
 *   - core.sshCommand=false — neutralize an attacker-set ssh command.
 *
 * NOT here: `diff.external`. Forcing `-c diff.external=` (empty) does NOT make
 * git fall back to the builtin diff — git tries to exec the empty string and
 * fails the whole diff ("external diff died", exit 128). The non-breaking
 * neutralizer is the per-command `--no-ext-diff`/`--no-textconv` flag, applied
 * at the `git.diffFile` call site (filegit.ts). The config-set form of
 * `diff.external`/`filter.*`/`*.textconv` is refused up front by the
 * exec-key scan in `project.open`. See `gitHardenedEnv` for the env vectors.
 */
const GIT_HARDENING = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.sshCommand=false',
];

/**
 * Hardened environment for every daemon-spawned git. Closes the env-and-system
 * config vectors a command-line `-c` cannot reach:
 *   - GIT_CONFIG_NOSYSTEM=1 — ignore /etc/gitconfig (a system-level
 *     diff.external/core.sshCommand would otherwise apply to every spawn).
 *   - GIT_CONFIG_GLOBAL pinned to the DAEMON's own ~/.gitconfig — the only
 *     trusted global, and immune to a $HOME-redirected global config. Pinning
 *     (rather than nulling) preserves the daemon's commit identity.
 *   - GIT_ATTR_NOSYSTEM=1 — ignore /etc/gitattributes, which can route a path
 *     through a filter/textconv driver (arbitrary command) on diff/checkout.
 *   - GIT_EXTERNAL_DIFF deleted — an inherited value would run on every diff.
 */
function gitHardenedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = join(homedir(), '.gitconfig');
  env.GIT_ATTR_NOSYSTEM = '1';
  delete env.GIT_EXTERNAL_DIFF;
  return env;
}

export function runGit(
  args: string[],
  cwd: string,
  opts?: Partial<RunChildOptions>,
): Promise<ShellResult> {
  return runChild('git', [...GIT_HARDENING, ...args], {
    cwd,
    env: gitHardenedEnv(),
    ...opts,
  });
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

async function agentWorkDir(
  db: import('@electric-sql/pglite').PGlite,
  agentId: string,
): Promise<string> {
  const r = await db.query<{ task: string }>(`SELECT task FROM agent_sessions WHERE id = $1`, [
    agentId,
  ]);
  return r.rows[0]?.task || process.cwd();
}

// ---------------------------------------------------------------------------
// worktree.*
// ---------------------------------------------------------------------------

registerHandler('worktree.create', async (params, db, ctx) => {
  if (!ctx.agentId) throw new Error('worktree.create: no registered session');
  const branch = strOrNull(params.branch);
  if (!branch) throw new Error('worktree.create: missing branch');
  const baseBranch = str(params.baseBranch, 'main');
  const cwd = await agentWorkDir(db, ctx.agentId);
  // Derive worktree path as ../<repo>-<branch>
  const worktreePath =
    strOrNull(params.path) ?? `${cwd.replace(/\/+$/, '')}-${branch.replace(/\//g, '-')}`;

  const result = await runGit(['worktree', 'add', '-b', branch, worktreePath, baseBranch], cwd);
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
    [ctx.agentId, branch, worktreePath, baseBranch],
  );
  return { success: true, branch, worktreePath, baseBranch };
});

registerHandler('worktree.list', async (params, db) => {
  const agentId = strOrNull(params.agentId);
  const sql = agentId
    ? `SELECT * FROM worktrees WHERE agent_id = $1 ORDER BY created_at DESC`
    : `SELECT * FROM worktrees WHERE status = 'active' ORDER BY created_at DESC`;
  const result = await db.query<Record<string, unknown>>(sql, agentId ? [agentId] : []);
  return { worktrees: result.rows };
});

registerHandler('worktree.remove', async (params, db, ctx) => {
  if (!ctx.agentId) throw new Error('worktree.remove: no registered session');
  const branch = strOrNull(params.branch);
  if (!branch) throw new Error('worktree.remove: missing branch');

  const row = await db.query<{ worktree_path: string }>(
    `SELECT worktree_path FROM worktrees
     WHERE agent_id = $1 AND branch = $2 AND status = 'active'`,
    [ctx.agentId, branch],
  );
  const worktreePath = row.rows[0]?.worktree_path;
  if (!worktreePath) {
    return { success: false, error: `No active worktree for branch ${branch}` };
  }
  const cwd = await agentWorkDir(db, ctx.agentId);
  const result = await runGit(['worktree', 'remove', worktreePath], cwd);
  if (!result.ok) {
    return { success: false, error: result.stderr || 'git worktree remove failed' };
  }
  await db.query(
    `UPDATE worktrees SET status = 'removed'
     WHERE agent_id = $1 AND branch = $2`,
    [ctx.agentId, branch],
  );
  return { success: true, branch, worktreePath };
});

// ---------------------------------------------------------------------------
// merge.*
// ---------------------------------------------------------------------------

registerHandler('merge.request', async (params, db, ctx) => {
  if (!ctx.agentId) throw new Error('merge.request: no registered session');
  const sourceBranch = strOrNull(params.branch) ?? strOrNull(params.sourceBranch);
  if (!sourceBranch) throw new Error('merge.request: missing branch');
  const baseBranch = str(params.targetBranch, str(params.baseBranch, 'main'));
  const description = str(params.description);
  const taskId = strOrNull(params.taskId);

  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO merge_requests (id, agent_id, task_id, source_branch, base_branch, status, error_message)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
    [id, ctx.agentId, taskId, sourceBranch, baseBranch, description || null],
  );
  return {
    success: true,
    mergeId: id,
    sourceBranch,
    baseBranch,
    status: 'pending',
  };
});

registerHandler('merge.status', async (params, db) => {
  const mergeId = strOrNull(params.mergeId);
  if (!mergeId) throw new Error('merge.status: missing mergeId');
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM merge_requests WHERE id = $1`,
    [mergeId],
  );
  if (result.rows.length === 0) {
    return { found: false };
  }
  return { found: true, ...result.rows[0] };
});

registerHandler('merge.list', async (params, db) => {
  const status = strOrNull(params.status);
  const agentId = strOrNull(params.agentId);

  const where: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (status && status !== 'all') {
    where.push(`status = $${i++}`);
    vals.push(status);
  }
  if (agentId) {
    where.push(`agent_id = $${i++}`);
    vals.push(agentId);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM merge_requests ${whereClause} ORDER BY created_at DESC LIMIT 100`,
    vals,
  );
  return { mergeRequests: result.rows };
});

registerHandler('merge.update', async (params, db, ctx) => {
  if (!ctx.agentId) throw new Error('merge.update: no registered session');
  const mergeId = strOrNull(params.mergeId);
  if (!mergeId) throw new Error('merge.update: missing mergeId');
  const status = strOrNull(params.status);
  const prNumber = typeof params.prNumber === 'number' ? params.prNumber : null;
  const prUrl = strOrNull(params.prUrl);
  const errorMessage = strOrNull(params.errorMessage);

  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];
  let i = 1;
  if (status) {
    sets.push(`status = $${i++}`);
    vals.push(status);
  }
  if (prNumber !== null) {
    sets.push(`pr_number = $${i++}`);
    vals.push(prNumber);
  }
  if (prUrl) {
    sets.push(`pr_url = $${i++}`);
    vals.push(prUrl);
  }
  if (errorMessage) {
    sets.push(`error_message = $${i++}`);
    vals.push(errorMessage);
  }
  vals.push(mergeId);
  const r = await db.query(`UPDATE merge_requests SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  return { updated: (r.affectedRows ?? 0) > 0 };
});
