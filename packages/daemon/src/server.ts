/**
 * Daemon RPC server — listens on Unix socket, dispatches JSON-RPC 2.0 calls.
 *
 * The server initializes PGlite, runs schema migrations, then accepts
 * newline-delimited JSON-RPC requests over the socket. Each request is
 * checked against the license guard before dispatch.
 */

import { createServer, type Socket } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { SCHEMA_SQL } from './storage/schema.js';
import { type DaemonConfig, DAEMON_DEFAULTS } from './config.js';
import { guardRpcMethod, initLicenseGuard, licenseErrorResponse } from './guard.js';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

type RpcHandler = (
  params: Record<string, unknown>,
  db: PGlite,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

const handlers = new Map<string, RpcHandler>();

/** Register an RPC method handler. */
export function registerHandler(method: string, handler: RpcHandler): void {
  handlers.set(method, handler);
}

// ---------------------------------------------------------------------------
// Built-in handlers
// ---------------------------------------------------------------------------

registerHandler('ping', async () => ({ pong: true, ts: Date.now() }));

registerHandler('session.register', async (params, db) => {
  const id = crypto.randomUUID();
  const { agentName, workDir, backend } = params as {
    agentName: string;
    workDir: string;
    backend: string;
  };
  await db.exec(
    `INSERT INTO agent_sessions (id, env, task)
     VALUES ('${id}', '${backend ?? 'unknown'}:${agentName ?? 'anon'}', '${workDir ?? ''}')`,
  );
  return { sessionId: id, agentName, backend };
});

registerHandler('session.list', async (_params, db) => {
  const result = await db.exec('SELECT * FROM agent_sessions WHERE ended_at IS NULL');
  return { sessions: result[0]?.rows ?? [] };
});

registerHandler('session.end', async (params, db) => {
  const { sessionId } = params as { sessionId: string };
  await db.exec(
    `UPDATE agent_sessions SET ended_at = NOW() WHERE id = '${sessionId}'`,
  );
  return { ended: sessionId };
});

registerHandler('session.update', async (params, db) => {
  const { sessionId, task, files } = params as {
    sessionId: string;
    task?: string;
    files?: string;
  };
  const sets: string[] = ['updated_at = NOW()'];
  if (task !== undefined) sets.push(`task = '${task}'`);
  if (files !== undefined) sets.push(`files = '${files}'`);
  await db.exec(
    `UPDATE agent_sessions SET ${sets.join(', ')} WHERE id = '${sessionId}'`,
  );
  return { updated: sessionId };
});

registerHandler('mail.send', async (params, db) => {
  const { to, subject, body } = params as {
    to: string;
    subject: string;
    body: string;
  };
  await db.exec(
    `INSERT INTO agent_messages (from_agent, to_agent, subject, body)
     VALUES ('self', '${to}', '${subject}', '${body}')`,
  );
  return { sent: true };
});

registerHandler('mail.inbox', async (params, db) => {
  const { unreadOnly } = params as { unreadOnly?: boolean };
  const where = unreadOnly !== false ? 'AND read = FALSE' : '';
  const result = await db.exec(
    `SELECT * FROM agent_messages WHERE to_agent = 'self' ${where} ORDER BY created_at DESC LIMIT 50`,
  );
  return { messages: result[0]?.rows ?? [] };
});

registerHandler('mail.broadcast', async (params, db) => {
  const { subject, body } = params as { subject: string; body: string };
  const sessions = await db.exec(
    'SELECT id FROM agent_sessions WHERE ended_at IS NULL',
  );
  const targets = (sessions[0]?.rows ?? []) as Array<{ id: string }>;
  for (const target of targets) {
    await db.exec(
      `INSERT INTO agent_messages (from_agent, to_agent, subject, body)
       VALUES ('self', '${target.id}', '${subject}', '${body}')`,
    );
  }
  return { broadcast: true, recipients: targets.length };
});

registerHandler('mail.markRead', async (params, db) => {
  const { messageIds } = params as { messageIds: string[] };
  for (const id of messageIds) {
    await db.exec(`UPDATE agent_messages SET read = TRUE WHERE id = ${id}`);
  }
  return { marked: messageIds.length };
});

registerHandler('files.reserve', async (params, db) => {
  const { paths, reason } = params as { paths: string[]; reason?: string };
  for (const p of paths) {
    await db.exec(
      `INSERT INTO file_reservations (file_path, agent_id, expires_at, reason)
       VALUES ('${p}', 'self', NOW() + INTERVAL '30 minutes', '${reason ?? ''}')
       ON CONFLICT (file_path) DO UPDATE SET agent_id = 'self', reserved_at = NOW(), expires_at = NOW() + INTERVAL '30 minutes'`,
    );
  }
  return { reserved: paths };
});

registerHandler('files.check', async (params, db) => {
  const { paths } = params as { paths: string[] };
  const result = await db.exec(
    `SELECT file_path, agent_id, expires_at FROM file_reservations
     WHERE file_path IN (${paths.map((p) => `'${p}'`).join(',')}) AND expires_at > NOW()`,
  );
  return { reservations: result[0]?.rows ?? [] };
});

registerHandler('files.release', async (params, db) => {
  const { paths } = params as { paths: string[] };
  await db.exec(
    `DELETE FROM file_reservations WHERE file_path IN (${paths.map((p) => `'${p}'`).join(',')})`,
  );
  return { released: paths };
});

registerHandler('files.list', async (_params, db) => {
  const result = await db.exec(
    'SELECT * FROM file_reservations WHERE expires_at > NOW() ORDER BY reserved_at DESC',
  );
  return { reservations: result[0]?.rows ?? [] };
});

registerHandler('tasks.create', async (params, db) => {
  const id = crypto.randomUUID();
  const { title, description, priority } = params as {
    title: string;
    description?: string;
    priority?: string;
  };
  await db.exec(
    `INSERT INTO tasks (id, description, status)
     VALUES ('${id}', '${priority ? `[${priority}] ` : ''}${title}${description ? ': ' + description : ''}', 'open')`,
  );
  return { taskId: id };
});

registerHandler('tasks.list', async (params, db) => {
  const { status } = params as { status?: string };
  const where = status && status !== 'all' ? `WHERE status = '${status}'` : '';
  const result = await db.exec(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`);
  return { tasks: result[0]?.rows ?? [] };
});

registerHandler('tasks.claim', async (params, db) => {
  const { taskId } = params as { taskId: string };
  await db.exec(
    `UPDATE tasks SET status = 'claimed', owner = 'self', claimed_at = NOW() WHERE id = '${taskId}'`,
  );
  return { claimed: taskId };
});

registerHandler('tasks.complete', async (params, db) => {
  const { taskId, summary } = params as { taskId: string; summary?: string };
  await db.exec(
    `UPDATE tasks SET status = 'completed', completed_at = NOW()${summary ? `, description = description || ' — ' || '${summary}'` : ''} WHERE id = '${taskId}'`,
  );
  return { completed: taskId };
});

registerHandler('tasks.release', async (params, db) => {
  const { taskId } = params as { taskId: string };
  await db.exec(
    `UPDATE tasks SET status = 'open', owner = NULL, claimed_at = NULL WHERE id = '${taskId}'`,
  );
  return { released: taskId };
});

registerHandler('events.log', async (params, db) => {
  const { agentId, eventType, payload } = params as {
    agentId: string;
    eventType: string;
    payload?: Record<string, unknown>;
  };
  await db.exec(
    `INSERT INTO events (agent_id, event_type, payload)
     VALUES ('${agentId}', '${eventType}', '${JSON.stringify(payload ?? {})}')`,
  );
  return { logged: true };
});

registerHandler('events.query', async (params, db) => {
  const { limit, since } = params as { limit?: number; since?: string };
  const where = since ? `WHERE created_at > '${since}'` : '';
  const result = await db.exec(
    `SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ${limit ?? 20}`,
  );
  return { events: result[0]?.rows ?? [] };
});

registerHandler('harness.health', async (_params, db) => {
  const sessions = await db.exec(
    'SELECT COUNT(*) as count FROM agent_sessions WHERE ended_at IS NULL',
  );
  const tasks = await db.exec(
    "SELECT COUNT(*) as count FROM tasks WHERE status = 'open'",
  );
  return {
    status: 'healthy',
    activeSessions: Number((sessions[0]?.rows[0] as { count: string })?.count ?? 0),
    openTasks: Number((tasks[0]?.rows[0] as { count: string })?.count ?? 0),
    uptime: process.uptime(),
  };
});

registerHandler('memory.store', async (params, db) => {
  const { key, value, tags } = params as {
    key: string;
    value: string;
    tags?: string[];
  };
  await db.exec(
    `INSERT INTO agent_memory (agent_id, memory_type, content, metadata)
     VALUES ('self', '${key}', '${value}', '${JSON.stringify({ tags: tags ?? [] })}')`,
  );
  return { stored: key };
});

registerHandler('memory.query', async (params, db) => {
  const { query, limit } = params as { query?: string; tags?: string[]; limit?: number };
  const where = query ? `AND content ILIKE '%${query}%'` : '';
  const result = await db.exec(
    `SELECT * FROM agent_memory WHERE agent_id = 'self' ${where} ORDER BY created_at DESC LIMIT ${limit ?? 10}`,
  );
  return { memories: result[0]?.rows ?? [] };
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startDaemon(
  config: Partial<DaemonConfig> = {},
): Promise<{ close: () => Promise<void> }> {
  const cfg = { ...DAEMON_DEFAULTS, ...config };

  // Initialize license guard (logs banner)
  initLicenseGuard();

  // Ensure data directory exists
  await mkdir(cfg.dataDir, { recursive: true });
  await mkdir(dirname(cfg.socketPath), { recursive: true });

  // Initialize PGlite
  console.log(`[daemon] Initializing database at ${cfg.dataDir}`);
  const db = new PGlite(cfg.dataDir);
  await db.exec(SCHEMA_SQL);
  console.log('[daemon] Schema initialized');

  // Remove stale socket
  const { unlink } = await import('node:fs/promises');
  await unlink(cfg.socketPath).catch(() => {});

  // Start Unix socket server
  const server = createServer((socket: Socket) => {
    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;

        let req: RpcRequest;
        try {
          req = JSON.parse(line);
        } catch {
          socket.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error' },
            }) + '\n',
          );
          continue;
        }

        // License guard
        const guard = guardRpcMethod(req.method);
        if (!guard.allowed) {
          socket.write(licenseErrorResponse(req.id, guard) + '\n');
          continue;
        }

        // Dispatch
        const handler = handlers.get(req.method);
        if (!handler) {
          socket.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32601, message: `Method not found: ${req.method}` },
            }) + '\n',
          );
          continue;
        }

        try {
          const result = await handler(req.params ?? {}, db);
          socket.write(
            JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n',
          );
        } catch (err) {
          socket.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              error: {
                code: -32000,
                message: err instanceof Error ? err.message : 'Internal error',
              },
            }) + '\n',
          );
        }
      }
    });

    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(cfg.socketPath, () => {
      console.log(`[daemon] Listening on ${cfg.socketPath}`);
      console.log('[daemon] Ready for connections');

      resolve({
        close: async () => {
          server.close();
          await db.close();
          await unlink(cfg.socketPath).catch(() => {});
          console.log('[daemon] Shut down');
        },
      });
    });
  });
}
