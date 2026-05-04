/**
 * @revdev/bridge — MCP server bridging AI coding tools to the RevDev Harness Daemon.
 *
 * Vendor-agnostic: works with any MCP-compatible tool (Claude Code, Codex,
 * Cursor, Windsurf, or custom agents). RevDev does not ship or endorse any
 * specific vendor — this bridge is a standard protocol adapter.
 *
 * Transport: stdio (MCP standard)
 * Daemon transport: Unix socket (JSON-RPC 2.0 over newline-delimited JSON)
 *
 * @packageDocumentation
 */

import { connect } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RPC_METHODS } from '@revdev/protocol';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Daemon RPC client
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class DaemonClient {
  private socketPath: string;
  private nextId = 1;

  constructor(socketPath?: string) {
    const home = process.env.HOME ?? '/tmp';
    this.socketPath = socketPath ?? `${home}/.local/share/revealui/harness.sock`;
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const req: RpcRequest = { jsonrpc: '2.0', id, method, params };

      const socket = connect(this.socketPath);
      let buffer = '';

      socket.on('connect', () => {
        socket.write(`${JSON.stringify(req)}\n`);
      });

      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const resp: RpcResponse = JSON.parse(line);
            if (resp.id === id) {
              socket.end();
              if (resp.error) {
                reject(new Error(`Daemon error ${resp.error.code}: ${resp.error.message}`));
              } else {
                resolve(resp.result);
              }
            }
          } catch {
            // incomplete JSON, wait for more data
          }
        }
      });

      socket.on('error', (err) => {
        reject(new Error(`Daemon connection failed: ${err.message}. Is revdev-daemon running?`));
      });

      socket.setTimeout(10_000, () => {
        socket.destroy();
        reject(new Error('Daemon request timed out'));
      });
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.call(RPC_METHODS.ping);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const daemon = new DaemonClient(process.env.REVDEV_DAEMON_SOCKET);

const server = new McpServer({
  name: 'revdev-bridge',
  version: '0.1.0',
});

// -- Session management ------------------------------------------------------

server.tool(
  'session_register',
  'Register this agent session with the harness daemon',
  {
    agentName: z.string().describe('Name for this agent (e.g. "claude-main")'),
    workDir: z.string().describe('Working directory for this session'),
    backend: z.string().optional().describe('Backend identifier (default: "mcp-agent")'),
  },
  async ({ agentName, workDir, backend }) => {
    const result = await daemon.call(RPC_METHODS['session.register'], {
      agentName,
      workDir,
      backend: backend ?? 'mcp-agent',
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'session_list',
  'List all active agent sessions connected to the daemon',
  {},
  async () => {
    const result = await daemon.call(RPC_METHODS['session.list']);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'session_end',
  'Deregister this agent session from the daemon',
  {
    sessionId: z.string().describe('Session ID to end'),
  },
  async ({ sessionId }) => {
    const result = await daemon.call(RPC_METHODS['session.end'], { sessionId });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'session_attach',
  'Re-bind an existing session ID to this connection (used by UIs that reconnect per call)',
  {
    sessionId: z.string().describe('Previously-registered session ID (a.k.a. agentId)'),
  },
  async ({ sessionId }) => {
    const result = await daemon.call(RPC_METHODS['session.attach'], { sessionId });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// -- Inter-agent messaging ---------------------------------------------------

server.tool(
  'mail_send',
  'Send a message to another agent session',
  {
    to: z.string().describe('Target agent session ID or name'),
    subject: z.string().describe('Message subject'),
    body: z.string().describe('Message body'),
    priority: z.enum(['low', 'normal', 'high']).optional().describe('Message priority'),
  },
  async ({ to, subject, body, priority }) => {
    const result = await daemon.call(RPC_METHODS['mail.send'], {
      to,
      subject,
      body,
      priority: priority ?? 'normal',
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'mail_inbox',
  'Check inbox for messages from other agents',
  {
    unreadOnly: z.boolean().optional().describe('Only show unread messages (default: true)'),
  },
  async ({ unreadOnly }) => {
    const result = await daemon.call(RPC_METHODS['mail.inbox'], {
      unreadOnly: unreadOnly ?? true,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'mail_broadcast',
  'Broadcast a message to all active agent sessions',
  {
    subject: z.string().describe('Message subject'),
    body: z.string().describe('Message body'),
  },
  async ({ subject, body }) => {
    const result = await daemon.call(RPC_METHODS['mail.broadcast'], { subject, body });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'mail_mark_read',
  'Mark inbox messages as read',
  {
    messageIds: z.array(z.number().int()).describe('Message IDs to mark as read'),
  },
  async ({ messageIds }) => {
    const result = await daemon.call(RPC_METHODS['mail.markRead'], { messageIds });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// -- File reservations -------------------------------------------------------

server.tool(
  'file_reserve',
  'Reserve files before editing to prevent conflicts with other agents',
  {
    paths: z.array(z.string()).describe('File paths to reserve'),
    reason: z.string().optional().describe('Why these files are being reserved'),
  },
  async ({ paths, reason }) => {
    const result = await daemon.call(RPC_METHODS['files.reserve'], { paths, reason });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'file_check',
  'Check if files are reserved by another agent before editing',
  {
    paths: z.array(z.string()).describe('File paths to check'),
  },
  async ({ paths }) => {
    const result = await daemon.call(RPC_METHODS['files.check'], { paths });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'file_release',
  'Release file reservations after editing is complete',
  {
    paths: z.array(z.string()).describe('File paths to release'),
  },
  async ({ paths }) => {
    const result = await daemon.call(RPC_METHODS['files.release'], { paths });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool('file_list', 'List all current file reservations across agents', {}, async () => {
  const result = await daemon.call(RPC_METHODS['files.list']);
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
});

// -- Task coordination -------------------------------------------------------

server.tool(
  'task_create',
  'Create a new coordination task for agents',
  {
    title: z.string().describe('Task title'),
    description: z.string().optional().describe('Task description'),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Task priority'),
  },
  async ({ title, description, priority }) => {
    const result = await daemon.call(RPC_METHODS['tasks.create'], { title, description, priority });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'task_list',
  'List available tasks for agent coordination',
  {
    status: z
      .enum(['pending', 'claimed', 'completed', 'all'])
      .optional()
      .describe('Filter by status'),
  },
  async ({ status }) => {
    const result = await daemon.call(RPC_METHODS['tasks.list'], { status: status ?? 'all' });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'task_claim',
  'Claim a task so other agents know you are working on it',
  {
    taskId: z.string().describe('Task ID to claim'),
  },
  async ({ taskId }) => {
    const result = await daemon.call(RPC_METHODS['tasks.claim'], { taskId });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'task_complete',
  'Mark a claimed task as completed',
  {
    taskId: z.string().describe('Task ID to complete'),
    summary: z.string().optional().describe('Summary of what was done'),
  },
  async ({ taskId, summary }) => {
    const result = await daemon.call(RPC_METHODS['tasks.complete'], { taskId, summary });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'task_release',
  'Release a claimed task back to the pool',
  {
    taskId: z.string().describe('Task ID to release'),
  },
  async ({ taskId }) => {
    const result = await daemon.call(RPC_METHODS['tasks.release'], { taskId });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// -- Agent memory ------------------------------------------------------------

server.tool(
  'memory_store',
  'Store a typed memory record for cross-session agent knowledge',
  {
    memoryType: z
      .string()
      .describe(
        'Memory category (e.g. "fact", "preference", "decision", or any agent-defined type)',
      ),
    content: z.string().describe('Memory content body'),
    tags: z.array(z.string()).optional().describe('Tags filed under metadata.tags for filtering'),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Free-form metadata; tags are merged in if both are provided'),
  },
  async ({ memoryType, content, tags, metadata }) => {
    // Merge tags into metadata so the daemon stores a single JSONB blob.
    const mergedMetadata = tags && tags.length > 0 ? { ...(metadata ?? {}), tags } : metadata;
    const result = await daemon.call(RPC_METHODS['memory.store'], {
      memoryType,
      content,
      metadata: mergedMetadata,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'memory_query',
  'Query stored agent memories',
  {
    memoryType: z.string().optional().describe('Filter by memory category (exact match)'),
    query: z.string().optional().describe('Full-text search filter on content'),
    tags: z.array(z.string()).optional().describe('Filter by metadata tags (any-of match)'),
    limit: z.number().optional().describe('Max results (default: 10)'),
  },
  async ({ memoryType, query, tags, limit }) => {
    const result = await daemon.call(RPC_METHODS['memory.query'], {
      memoryType,
      query,
      tags,
      limit: limit ?? 10,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// -- Merge pipeline ----------------------------------------------------------

server.tool(
  'merge_request',
  'Request a merge review from the daemon merge pipeline',
  {
    sourceBranch: z.string().describe('Branch to merge (head)'),
    baseBranch: z.string().optional().describe('Branch to merge into (default: main)'),
    description: z.string().optional().describe('Merge description'),
  },
  async ({ sourceBranch, baseBranch, description }) => {
    const result = await daemon.call(RPC_METHODS['merge.request'], {
      sourceBranch,
      baseBranch: baseBranch ?? 'main',
      description,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'merge_status',
  'Check the status of a merge request',
  {
    mergeId: z.string().describe('Merge request ID'),
  },
  async ({ mergeId }) => {
    const result = await daemon.call(RPC_METHODS['merge.status'], { mergeId });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool('merge_list', 'List all merge requests', {}, async () => {
  const result = await daemon.call(RPC_METHODS['merge.list']);
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
});

// -- Worktree management -----------------------------------------------------

server.tool(
  'worktree_create',
  'Create a git worktree for isolated work',
  {
    branch: z.string().describe('Branch name for the worktree'),
    baseBranch: z.string().optional().describe('Base branch (default: main)'),
  },
  async ({ branch, baseBranch }) => {
    const result = await daemon.call(RPC_METHODS['worktree.create'], {
      branch,
      baseBranch: baseBranch ?? 'main',
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool('worktree_list', 'List active git worktrees', {}, async () => {
  const result = await daemon.call(RPC_METHODS['worktree.list']);
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
});

server.tool(
  'worktree_remove',
  'Remove a git worktree',
  {
    branch: z.string().describe('Branch name of the worktree to remove'),
  },
  async ({ branch }) => {
    const result = await daemon.call(RPC_METHODS['worktree.remove'], { branch });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// -- Daemon health -----------------------------------------------------------

server.tool(
  'daemon_status',
  'Check if the RevDev harness daemon is running and healthy',
  {},
  async () => {
    const alive = await daemon.ping();
    if (!alive) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Daemon is not running. Start it with: revdev-daemon start',
          },
        ],
      };
    }
    const health = await daemon.call(RPC_METHODS['harness.health']);
    return { content: [{ type: 'text' as const, text: JSON.stringify(health, null, 2) }] };
  },
);

// -- Event log ---------------------------------------------------------------

server.tool(
  'events_query',
  'Query the daemon event log for recent activity across all agents',
  {
    limit: z.number().optional().describe('Max events to return (default: 20)'),
    since: z.string().optional().describe('ISO timestamp to query from'),
  },
  async ({ limit, since }) => {
    const result = await daemon.call(RPC_METHODS['events.query'], {
      limit: limit ?? 20,
      since,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Bridge startup failed:', err);
  process.exit(1);
});
