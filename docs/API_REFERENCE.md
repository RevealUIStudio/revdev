# Daemon RPC API Reference

The RevDev Harness Daemon exposes a JSON-RPC 2.0 API over Unix socket at `~/.local/share/revealui/harness.sock`.

## Transport

- **Protocol**: JSON-RPC 2.0, newline-delimited
- **Socket**: Unix domain socket (local) or HTTP gateway (remote, when enabled)
- **Connection model**: Fresh socket per call (no persistent connections required)

## Authentication

Local socket access is trust-based (mode 0600, owner-only). Identity is established by calling `session.register` once, then passing the returned `sessionId` as `actorAgentId` on subsequent calls.

## License Gating

Methods marked with a tier require that tier or higher. Free tier methods are always available.

---

## System

### `ping`
**Tier**: Free

Returns a pong response to verify daemon connectivity.

**Params**: none  
**Response**: `{ pong: true, ts: number }`

---

### `harness.health`
**Tier**: Free

Returns daemon health status, active session count, and optionally detailed checks and Prometheus metrics.

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `detailed` | boolean? | Include health check results |
| `metrics` | boolean? | Include Prometheus metrics string |

**Response**:
```json
{
  "status": "healthy",
  "activeSessions": 3,
  "openTasks": 5,
  "uptime": 86400,
  "memoryUsage": 52428800,
  "checks": { ... },
  "metrics": "# HELP revdev_daemon_rpc_calls_total..."
}
```

---

## Sessions

### `session.register`
**Tier**: Free

Register a new agent session. Returns a sessionId to use as identity.

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `agentId` | string? | Stable ID (upserts if exists). Omit for ephemeral UUID. |
| `agentName` | string? | Human-readable name (e.g., "agent-main") |
| `workDir` | string? | Agent's working directory |
| `backend` | string? | Agent backend type (e.g., "studio", "mcp-agent") |

**Response**: `{ sessionId: string }`

---

### `session.attach`
**Tier**: Free

Attach to an existing session by ID. Binds the socket to that identity.

**Params**: `{ sessionId: string }`  
**Response**: `{ attached: true }`

---

### `session.list`
**Tier**: Free

List all active sessions.

**Params**: none  
**Response**: Array of session objects.

---

### `session.update`
**Tier**: Free

Update the current session's task/files description.

**Params**: `{ task?: string, files?: string }`  
**Response**: `{ updated: true }`

---

### `session.end`
**Tier**: Free

End the current session. Optionally record an exit summary.

**Params**: `{ exitSummary?: string }`  
**Response**: `{ ended: true }`

---

## Mail (Inter-Agent Messaging)

### `mail.send`
**Tier**: Pro

Send a message to another agent.

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `to` | string | Recipient agent ID |
| `subject` | string | Message subject (max 500 chars) |
| `body` | string | Message body (max 50KB) |

**Response**: `{ sent: true, id: number }`

---

### `mail.inbox`
**Tier**: Pro

Get messages for an agent.

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `agentId` | string? | Target agent (defaults to caller) |
| `unreadOnly` | boolean? | Only unread messages (default: true) |

**Response**: `{ messages: Message[] }`

---

### `mail.broadcast`
**Tier**: Pro

Send a message to all active agents (except sender).

**Params**: `{ subject: string, body: string }`  
**Response**: `{ broadcast: true, sent: number }`

---

### `mail.markRead`
**Tier**: Pro

Mark messages as read by ID.

**Params**: `{ messageIds: number[] }`  
**Response**: `{ marked: number }`

---

## Files (Reservation System)

### `files.reserve`
**Tier**: Pro

Reserve files for exclusive editing. Prevents other agents from modifying.

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `filePath` | string? | Single file path |
| `paths` | string[]? | Multiple file paths |
| `ttlSeconds` | number? | Reservation TTL (default: 600, max: 86400) |
| `reason` | string? | Why the file is reserved |

**Response**: `{ reserved: string[], conflicts: { path, holder }[] }`

---

### `files.check`
**Tier**: Pro

Check who holds a file reservation.

**Params**: `{ filePath?: string, paths?: string[] }`  
**Response**: Array of reservations or null if unreserved.

---

### `files.release`
**Tier**: Pro

Release file reservations.

**Params**: `{ filePath?: string, paths?: string[] }`  
**Response**: `{ released: number }`

---

### `files.list`
**Tier**: Pro

List all active file reservations.

**Params**: `{ agentId?: string }` (use `"__all__"` for all agents)  
**Response**: Array of reservation objects.

---

## Tasks

### `tasks.create`
**Tier**: Pro

Create a coordination task.

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `taskId` | string? | Custom ID (auto-generated if omitted) |
| `title` | string? | Short title (max 500 chars) |
| `description` | string? | Full description (max 50KB) |

**Response**: `{ taskId: string, id: string }`

---

### `tasks.list`
**Tier**: Pro

List tasks with optional filters.

**Params**: `{ status?: string, owner?: string }`  
**Response**: `{ tasks: Task[] }`

---

### `tasks.claim`
**Tier**: Pro

Claim an open task. Only one agent can own a task.

**Params**: `{ taskId: string }`  
**Response**: `{ success: boolean, owner: string }`

---

### `tasks.complete`
**Tier**: Pro

Complete a claimed task. Only the owner can complete it.

**Params**: `{ taskId: string }`  
**Response**: `{ completed: true }`

---

### `tasks.release`
**Tier**: Pro

Release a claimed task back to open status.

**Params**: `{ taskId: string }`  
**Response**: `{ released: true }`

---

## Events (Audit Log)

### `events.log`
**Tier**: Pro

Log a structured event.

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Event type (max 128 chars) |
| `payload` | object? | JSON payload (max 100KB) |

**Response**: `{ logged: true }`

---

### `events.query`
**Tier**: Pro

Query recent events.

**Params**: `{ limit?: number, since?: string }`  
**Response**: `{ events: Event[] }`

---

## Memory

### `memory.store`
**Tier**: Max

Store long-term agent memory.

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `memoryType` | string | Category (max 64 chars) |
| `content` | string | Memory content (max 500KB) |
| `metadata` | object? | Structured metadata |

**Response**: `{ stored: true, id: number }`

---

### `memory.query`
**Tier**: Max

Query stored memories.

**Params**: `{ memoryType?: string, limit?: number }`  
**Response**: `{ memories: Memory[] }`

---

## Inference

### `inference.status`
**Tier**: Max (identity-exempt)

Check Ollama inference status and loaded models.

**Params**: none  
**Response**: `{ available: boolean, models: Model[] }`

---

### `inference.pull`
**Tier**: Max

Download a model via Ollama.

**Params**: `{ model: string }`  
**Response**: `{ pulled: true }`

---

### `inference.start` / `inference.stop`
**Tier**: Max

Warm up or unload a model.

**Params**: `{ model: string }`

---

### `inference.chat`
**Tier**: Max

Chat completion via Ollama.

**Params**: `{ model: string, messages: { role, content }[] }`  
**Response**: `{ message: { role, content } }`

---

### `inference.generate`
**Tier**: Max

Text generation via Ollama.

**Params**: `{ model: string, prompt: string }`  
**Response**: `{ response: string }`

---

## Worktrees

### `worktree.create`
**Tier**: Pro

Create a git worktree for isolated branch work.

**Params**: `{ branch: string, baseBranch?: string }`  
**Response**: `{ created: true, path: string }`

---

### `worktree.list`
**Tier**: Pro

List active worktrees.

**Response**: `{ worktrees: Worktree[] }`

---

### `worktree.remove`
**Tier**: Pro

Remove a worktree.

**Response**: `{ removed: true }`

---

## Merge Pipeline

### `merge.request`
**Tier**: Pro

Create a merge request (tracked in daemon; PR creation is client-side).

**Params**: `{ sourceBranch: string, baseBranch?: string, taskId?: string }`  
**Response**: `{ mergeId: string }`

---

### `merge.status`
**Tier**: Pro

Get merge request status.

**Params**: `{ mergeId: string }`  
**Response**: Merge request object.

---

### `merge.list`
**Tier**: Pro

List merge requests.

**Params**: `{ status?: string }`  
**Response**: Array of merge requests.

---

### `merge.update`
**Tier**: Pro

Update merge request status (e.g., after PR creation or CI result).

**Params**: `{ mergeId: string, status?: string, prNumber?: number, prUrl?: string, errorMessage?: string }`  
**Response**: `{ updated: true }`

---

## Error Codes

| Code | Meaning |
|------|---------|
| -32700 | Parse error (malformed JSON) |
| -32601 | Method not found |
| -32602 | Invalid params (Zod validation failed) |
| -32001 | License required (tier too low) |
| -32002 | Identity required (call session.register first) |
| -32000 | Internal error (handler threw) |

---

## Input Limits

All params are validated with Zod schemas. Key limits:

| Field | Max |
|-------|-----|
| Names/IDs | 256 chars |
| Subject | 500 chars |
| Body/description | 50 KB |
| File path | 4,096 chars |
| Event payload | 100 KB |
| Memory content | 500 KB |
| Batch operations | 100-200 items |
| Query limit | 500 rows |
| File TTL | 86,400 seconds (24h) |

Path traversal (`../`) and system paths (`/etc/`, `/proc/`, `/sys/`) are blocked.
