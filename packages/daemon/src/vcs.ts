/**
 * VCS handlers — git worktree management and merge-request tracking.
 *
 * Worktrees are real: we shell out to `git worktree add/remove` in the
 * agent's working directory. Merge requests are tracked in the
 * `merge_requests` table; actual PR creation is left to the client
 * (agents call `gh pr create` themselves and then update status here).
 */

import { spawn } from 'node:child_process';
import { registerHandler } from './server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

function runGit(args: string[], cwd: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: code ?? -1,
      });
    });
    child.on('error', (err) => {
      resolve({ ok: false, stdout: '', stderr: err.message, code: -1 });
    });
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
