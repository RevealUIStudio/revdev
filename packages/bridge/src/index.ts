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













import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connect } from 'node:net';
import { RPC_METHODS } from '@revdev/protocol';

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
    const home = process.env['HOME'] ?? '/tmp';
    this.socketPath = socketPath ?? `${home}/.local/share/revealui/harness.sock`;
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const req: RpcRequest = { jsonrpc: '2.0', id, method, params };

      const socket = connect(this.socketPath);
      let buffer = '';

      socket.on('connect', () => {
        socket.write(JSON.stringify(req) + '\n');
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

const daemon = new DaemonClient(process.env['REVDEV_DAEMON_SOCKET']);

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
    agentId: z.string().describe('Previously-registered session/agent ID'),
  },
  async ({ agentId }) => {
    const result = await daemon.call(RPC_METHODS['session.attach'], { agentId });
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

server.tool(
  'file_list',
  'List all current file reservations across agents',
  {},
  async () => {
    const result = await daemon.call(RPC_METHODS['files.list']);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

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
    status: z.enum(['pending', 'claimed', 'completed', 'all']).optional().describe('Filter by status'),
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
  'Store a memory for cross-session agent knowledge',
  {
    key: z.string().describe('Memory key'),
    value: z.string().describe('Memory content'),
    tags: z.array(z.string()).optional().describe('Tags for filtering'),
  },
  async ({ key, value, tags }) => {
    const result = await daemon.call(RPC_METHODS['memory.store'], { key, value, tags });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'memory_query',
  'Query stored agent memories',
  {
    query: z.string().optional().describe('Search query'),
    tags: z.array(z.string()).optional().describe('Filter by tags'),
    limit: z.number().optional().describe('Max results (default: 10)'),
  },
  async ({ query, tags, limit }) => {
    const result = await daemon.call(RPC_METHODS['memory.query'], {
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
    branch: z.string().describe('Branch to merge'),
    targetBranch: z.string().optional().describe('Target branch (default: main)'),
    description: z.string().optional().describe('Merge description'),
  },
  async ({ branch, targetBranch, description }) => {
    const result = await daemon.call(RPC_METHODS['merge.request'], {
      branch,
      targetBranch: targetBranch ?? 'main',
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

server.tool(
  'merge_list',
  'List all merge requests',
  {},
  async () => {
    const result = await daemon.call(RPC_METHODS['merge.list']);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

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

server.tool(
  'worktree_list',
  'List active git worktrees',
  {},
  async () => {
    const result = await daemon.call(RPC_METHODS['worktree.list']);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

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
