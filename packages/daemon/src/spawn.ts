/**
 * agent.* handlers — PTY-backed process spawning + supervision.
 *
 * Implements the non-identity half of P4 (ADR 2026-06-25 "agnostic Reasoner
 * port + Driver-pluggable loop"). This module:
 *   - Maintains an in-memory registry of live PTY handles (Map<processId, entry>)
 *   - Persists metadata rows in `agent_processes` (survives restart as 'exited')
 *   - Buffers output in `agent_process_output` for poll-based `agent.output`
 *   - Enforces per-agent ownership: only the spawning agent may send input,
 *     resize, or stop a process it owns
 *
 * Authentication: all five methods are in MUTATING_OR_CONTENT_METHODS and in
 * signing.rs requires_signature(), so the dispatch gate binds ctx.agentId to a
 * verified Ed25519 signer. The spoofable actorAgentId param auth is gone.
 *
 * Authorization: agent.spawn additionally requires the signer to hold (own, or
 * have been granted) the project root its command will run in. See the handler.
 */

import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createLogger } from '@revealui/utils/logger';
import type { IDisposable, IPty } from 'node-pty';
import * as nodePty from 'node-pty';
import { onAgentEnded } from './eviction.js';
import { requireDirInRoot } from './filegit.js';
import { registerHandler, type SocketContext } from './server.js';

const log = createLogger({ service: 'revdev-daemon/spawn' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum concurrent PTY processes per agent (best-effort; not a hard OS cap). */
const MAX_PROCESSES_PER_AGENT = 10;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface ProcessEntry {
  pty: IPty;
  ownerAgentId: string;
  dataDisposable: IDisposable;
  exitDisposable: IDisposable;
  outputSeq: number;
}

/**
 * Live PTY handles, keyed by processId. PTY objects cannot be serialised or
 * stored in the database — on daemon restart all processes are gone, and
 * their DB rows are left in 'running' status. Callers should treat a 'running'
 * row with no matching registry entry as unreachable after a restart.
 */
const registry = new Map<string, ProcessEntry>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function liveCountForAgent(ownerAgentId: string): number {
  let n = 0;
  for (const entry of registry.values()) {
    if (entry.ownerAgentId === ownerAgentId) n++;
  }
  return n;
}

/**
 * Append a PTY data chunk to the DB output buffer. Fire-and-forget: the PTY
 * onData callback is synchronous so we cannot await here. Errors are logged
 * but do not surface to the caller; output may be dropped if the DB is busy.
 */
function bufferOutput(db: PGlite, processId: string, chunk: string): void {
  const entry = registry.get(processId);
  if (!entry) return;
  entry.outputSeq++;
  const seq = entry.outputSeq;
  db.query(
    `INSERT INTO agent_process_output (process_id, seq, stream, chunk)
     VALUES ($1, $2, 'pty', $3)`,
    [processId, seq, chunk],
  ).catch((err: unknown) => {
    log.warn('output buffer write failed', { processId, seq, error: String(err) });
  });
}

/**
 * Mark a process row as exited in the DB. Fire-and-forget (called from the
 * synchronous onExit callback).
 */
function markExited(db: PGlite, processId: string, exitCode: number | null): void {
  registry.delete(processId);
  db.query(
    `UPDATE agent_processes
        SET status = 'exited', exit_code = $2, ended_at = NOW()
      WHERE id = $1`,
    [processId, exitCode],
  ).catch((err: unknown) => {
    log.warn('process exit DB update failed', { processId, error: String(err) });
  });
}

// ---------------------------------------------------------------------------
// Eviction: kill all processes owned by an agent when its session ends
// ---------------------------------------------------------------------------

onAgentEnded((agentId: string) => {
  for (const [processId, entry] of registry) {
    if (entry.ownerAgentId !== agentId) continue;
    try {
      entry.pty.kill();
    } catch {
      // PTY may already be dead; ignore
    }
    registry.delete(processId);
  }
});

// ---------------------------------------------------------------------------
// Minimal safe environment for spawned processes
// ---------------------------------------------------------------------------

/**
 * Build a minimal environment for a spawned PTY process. We do NOT inherit
 * `process.env` blindly because that would pass revvault secrets, API keys,
 * and signing material to the child.
 *
 * P4-IDENTITY TODO: once the B6 project.grant model ships, gate which env
 * keys a spawned-agent DID may request against the grant.
 */
function buildSafeEnv(extraEnv: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: process.env.HOME ?? '/tmp',
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    TERM: 'xterm-color',
    LANG: 'C.UTF-8',
  };
  for (const [k, v] of Object.entries(extraEnv)) {
    base[k] = v;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Local parameter extraction helpers
// ---------------------------------------------------------------------------

// agent.* is signature-gated: every method is in server.ts
// MUTATING_OR_CONTENT_METHODS and in signing.rs requires_signature(), so the
// dispatch gate has already verified the Ed25519 signature and bound ctx.agentId
// to the VERIFIED signer (boundVia==='signature') before this handler runs.
// Trust ONLY that binding. The old spoofable params.actorAgentId fallback is
// removed — it let a client name another agent as the PTY/exec owner (the
// 2026-06-29 Part B cross-agent PTY-hijack finding) and let an unsigned host
// process drive agent.spawn as the daemon UID (the unsigned-RCE finding). The
// dispatch gate rejects unsigned calls with -32003 before we get here; this is
// the defense-in-depth backstop. `_params` is retained for call-site parity.
function requireAgent(ctx: SocketContext, _params: Record<string, unknown>): string {
  if (ctx.boundVia === 'signature' && ctx.agentId) return ctx.agentId;
  throw new Error(
    'agent.* requires a signed request (verified Ed25519 signature); unsigned or param-bound actor rejected',
  );
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === 'string' ? v : '';
}

function stringArrayParam(params: Record<string, unknown>, key: string): string[] {
  const v = params[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function positiveIntOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function safeEnvRecord(v: unknown): Record<string, string> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  const result: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k === 'string' && typeof val === 'string') {
      result[k] = val;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * agent.spawn — fork a PTY child process and return processId + pid.
 *
 * Security:
 *   - Signature-gated: requireAgent() accepts only a verified Ed25519 signer,
 *     never a caller-supplied actorAgentId.
 *   - Authorized: `repoPath` must be a registered root the signer owns or was
 *     granted, and `cwd` must resolve at or beneath it (requireDirInRoot).
 *     There is no default cwd; a missing repoPath is a hard error.
 *   - env is built from a minimal baseline (see buildSafeEnv).
 *   - Per-agent concurrency is capped at MAX_PROCESSES_PER_AGENT.
 *
 * Still open: `command` itself is not constrained to an allow-list, so an
 * authorized caller may run any binary within a root it holds.
 */
registerHandler('agent.spawn', async (params, db, ctx) => {
  const ownerAgentId = requireAgent(ctx, params);

  const command = stringParam(params, 'command');
  if (!command) throw new Error('agent.spawn: missing command');

  const args = stringArrayParam(params, 'args');
  const cols = positiveInt(params.cols, 80);
  const rows = positiveInt(params.rows, 24);
  const extraEnv = safeEnvRecord(params.env);

  // Authorization. The signature gate above proves WHO is asking; this proves
  // they may run a command THERE. `repoPath` must be a root the signer opened
  // or was granted via project.grant, and `cwd` must resolve to a real
  // directory at or beneath it.
  //
  // Fail closed: `repoPath` is required. The previous default silently fell
  // back to $HOME, so any verified agent could fork a command as the daemon UID
  // anywhere in the operator's home directory.
  const repoPath = stringParam(params, 'repoPath');
  if (!repoPath) {
    throw new Error('agent.spawn: missing repoPath (call project.open on the root first)');
  }
  const cwd = await requireDirInRoot(
    repoPath,
    stringParam(params, 'cwd') || undefined,
    ownerAgentId,
  );

  if (liveCountForAgent(ownerAgentId) >= MAX_PROCESSES_PER_AGENT) {
    throw new Error(
      `agent.spawn: per-agent process limit (${MAX_PROCESSES_PER_AGENT}) reached for agent ${ownerAgentId}`,
    );
  }

  const processId = randomUUID();
  const env = buildSafeEnv(extraEnv);

  // P4-IDENTITY TODO: before spawning, verify the caller holds a project.grant
  // for the command/cwd combination. Requires the grant model from the B6 lane.
  const pty = nodePty.spawn(command, args, {
    name: 'xterm-color',
    cols,
    rows,
    cwd,
    env,
  });

  await db.query(
    `INSERT INTO agent_processes (id, owner_agent, command, args, cwd, pid, status)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'running')`,
    [processId, ownerAgentId, command, JSON.stringify(args), cwd, pty.pid],
  );

  const entry: ProcessEntry = {
    pty,
    ownerAgentId,
    outputSeq: 0,
    dataDisposable: pty.onData((chunk) => bufferOutput(db, processId, chunk)),
    exitDisposable: pty.onExit(({ exitCode }) => {
      entry.dataDisposable.dispose();
      entry.exitDisposable.dispose();
      markExited(db, processId, exitCode ?? null);
      log.info('process exited', { processId, exitCode });
    }),
  };
  registry.set(processId, entry);

  log.info('spawned PTY process', { processId, command, pid: pty.pid, ownerAgentId });

  return { processId, pid: pty.pid };
});

/**
 * agent.stop — send SIGTERM to the PTY and mark the DB row killed.
 *
 * P4-IDENTITY TODO: signature-gate (see agent.spawn TODO above).
 */
registerHandler('agent.stop', async (params, db, ctx) => {
  const callerAgentId = requireAgent(ctx, params);
  const processId = stringParam(params, 'processId');
  if (!processId) throw new Error('agent.stop: missing processId');

  const entry = registry.get(processId);
  if (!entry) {
    const row = await db.query<{ owner_agent: string; status: string }>(
      `SELECT owner_agent, status FROM agent_processes WHERE id = $1`,
      [processId],
    );
    if (row.rows.length === 0) throw new Error(`agent.stop: unknown processId ${processId}`);
    const r = row.rows[0];
    if (r && r.owner_agent !== callerAgentId) {
      throw new Error(`agent.stop: process ${processId} is not owned by caller`);
    }
    return { stopped: processId, status: r?.status ?? 'unknown' };
  }

  if (entry.ownerAgentId !== callerAgentId) {
    throw new Error(`agent.stop: process ${processId} is not owned by caller`);
  }

  try {
    entry.pty.kill();
  } catch {
    // PTY kill is best-effort; it may already be dead
  }

  registry.delete(processId);

  await db.query(
    `UPDATE agent_processes
        SET status = 'killed', ended_at = NOW()
      WHERE id = $1`,
    [processId],
  );

  return { stopped: processId, status: 'killed' };
});

/**
 * agent.input — write bytes to a live PTY's stdin/tty.
 *
 * P4-IDENTITY TODO: signature-gate (see agent.spawn TODO above).
 */
registerHandler('agent.input', async (params, _db, ctx) => {
  const callerAgentId = requireAgent(ctx, params);
  const processId = stringParam(params, 'processId');
  if (!processId) throw new Error('agent.input: missing processId');
  const data = stringParam(params, 'data');
  if (!data) throw new Error('agent.input: missing data');

  const entry = registry.get(processId);
  if (!entry) throw new Error(`agent.input: process ${processId} is not running`);
  if (entry.ownerAgentId !== callerAgentId) {
    throw new Error(`agent.input: process ${processId} is not owned by caller`);
  }

  entry.pty.write(data);
  return { written: true };
});

/**
 * agent.resize — resize the PTY window.
 *
 * P4-IDENTITY TODO: signature-gate (see agent.spawn TODO above).
 */
registerHandler('agent.resize', async (params, _db, ctx) => {
  const callerAgentId = requireAgent(ctx, params);
  const processId = stringParam(params, 'processId');
  if (!processId) throw new Error('agent.resize: missing processId');
  const cols = positiveInt(params.cols, 80);
  const rows = positiveInt(params.rows, 24);

  const entry = registry.get(processId);
  if (!entry) throw new Error(`agent.resize: process ${processId} is not running`);
  if (entry.ownerAgentId !== callerAgentId) {
    throw new Error(`agent.resize: process ${processId} is not owned by caller`);
  }

  entry.pty.resize(cols, rows);
  return { resized: true, cols, rows };
});

/**
 * agent.output — poll-based output retrieval.
 *
 * Returns buffered chunks for a process since `cursor` (exclusive lower bound
 * on the `id` PK of `agent_process_output`). Pass `cursor: 0` or omit to
 * read from the beginning. The `cursor` in the response should be passed on
 * the next poll. `status` tells the caller when to stop polling.
 *
 * Real-time push is not available over this JSON-RPC transport (newline-
 * delimited JSON has no server-push model). Poll-based mirrors events.query.
 *
 * P4-IDENTITY TODO: signature-gate (see agent.spawn TODO above).
 */
registerHandler('agent.output', async (params, db, ctx) => {
  const callerAgentId = requireAgent(ctx, params);
  const processId = stringParam(params, 'processId');
  if (!processId) throw new Error('agent.output: missing processId');
  const cursor = positiveIntOrZero(Number(params.cursor ?? 0));
  const limit = Math.min(positiveInt(params.limit, 100), 1000);

  const procRow = await db.query<{ owner_agent: string; status: string }>(
    `SELECT owner_agent, status FROM agent_processes WHERE id = $1`,
    [processId],
  );
  if (procRow.rows.length === 0) throw new Error(`agent.output: unknown processId ${processId}`);
  const proc = procRow.rows[0];
  if (!proc) throw new Error(`agent.output: unknown processId ${processId}`);
  if (proc.owner_agent !== callerAgentId) {
    throw new Error(`agent.output: process ${processId} is not owned by caller`);
  }

  const outputRows = await db.query<{ id: string; seq: number; stream: string; chunk: string }>(
    `SELECT id, seq, stream, chunk
       FROM agent_process_output
      WHERE process_id = $1 AND id::bigint > $2
      ORDER BY id
      LIMIT $3`,
    [processId, cursor, limit],
  );

  const chunks = outputRows.rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    stream: r.stream,
    chunk: r.chunk,
  }));

  const nextCursor =
    chunks.length > 0 ? String(chunks[chunks.length - 1]?.id ?? cursor) : String(cursor);

  return {
    chunks,
    cursor: nextCursor,
    status: proc.status,
  };
});
