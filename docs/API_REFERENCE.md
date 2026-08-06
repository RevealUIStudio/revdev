# Daemon RPC API Reference

The RevDev Harness Daemon exposes a JSON-RPC 2.0 API over Unix socket at `~/.local/share/revealui/harness.sock`.

## Transport

- **Protocol**: JSON-RPC 2.0, newline-delimited
- **Socket**: Unix domain socket (local) or HTTP gateway (remote, when enabled)
- **Connection model**: Fresh socket per call (no persistent connections required)

## Authentication

Local socket access is trust-based (mode 0600, owner-only). Identity is established by calling `session.register` once, then passing the returned `sessionId` as `actorAgentId` on subsequent calls (or keeping the socket open, which stays bound to that identity for its lifetime).

### Signing

Every mutation and every content-returning read additionally requires a verified Ed25519 request signature (the `x-revdev-signature` field on the JSON-RPC frame), not just a registered session. These methods reject an unsigned or `actorAgentId`-only caller with `-32003` before the handler ever runs, even after a successful `session.register`. They are marked **Signature: required** below. Most coordination methods (mail, tasks, memory, file reservations) accept either a verified signature or a daemon-minted bound identity instead. See `docs/SPEC.md` and `docs/KEY_GENERATION.md` for the full client-identity model.

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
**Tier**: Free (GAP-337 — monitoring without a Pro license; `harness.prune` remains Pro)

Returns daemon health status, active session/task counts, prune state, and client-identity anchor consistency. Takes no params (any passed are ignored).

**Params**: none
**Response**:
```json
{
  "status": "healthy",
  "activeSessions": 3,
  "openTasks": 5,
  "uptime": 86400,
  "prune": { "lastRunAt": "2026-07-10T00:00:00.000Z", "lastAgedCount": 0, "lastDeletedCount": 0 },
  "neonSyncActive": false,
  "identitySignatureMode": "accept-if-present",
  "anchorInconsistencies": []
}
```

---

### `harness.prune`
**Tier**: Pro
**Signature**: required

Run a stale-session reap pass on demand: marks sessions older than `staleDays` as ended, hard-deletes sessions ended longer than `hardDeleteDays` ago, and evicts filesystem roots for every reaped session. Also runs automatically on a periodic internal timer.

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `staleDays` | number? | Floored at 1 (default from daemon config) |
| `hardDeleteDays` | number? | Floored at 1 (default from daemon config) |

**Response**: `{ aged: number, deleted: number, runAt: string | null, staleDays: number, hardDeleteDays: number }`

---

## Sessions

### `session.register`
**Tier**: Free

Register a new agent session. Returns a sessionId to use as identity. Two ownership models: pass `publicKeyPem` for a client-owned (Studio) identity, or omit it for a daemon-minted identity (headless hooks).

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `agentId` | string? | Stable ID (upserts if exists). Omit for ephemeral UUID. |
| `agentName` | string? | Human-readable name (e.g., "agent-main") |
| `workDir` | string? | Agent's working directory (alias: `task`) |
| `backend` | string? | Agent backend type, e.g. "studio", "mcp-agent" (alias: `env`) |
| `pid` | number? | Caller process ID |
| `publicKeyPem` | string? | Client-owned Ed25519 SPKI PEM public key (Studio zero-9P model); the fingerprint must be in the daemon's trust anchor or registration fails with -32004 |

**Response**: `{ sessionId: string, agentId: string, agentName: string, backend: string, did: string, publicKeyPem: string, privateKeyPem?: string, warnings?: unknown[], session: { id, env, task } }`

`privateKeyPem` is returned **only** on the first daemon-minted bootstrap. It is never returned for client-owned enroll or for re-register of an existing identity. Intended consumers (all daily-driver harnesses, not Claude alone):

| Client | How it stores the key |
|--------|------------------------|
| Claude Code / Grok hooks | `~/.local/share/revealui/hook-identities/<agentId>.json` |
| Studio Ubuntu Inference Snap / Ollama spawn | in-memory on the agent process for signed `session.end` |
| MCP bridge | `REVDEV_AGENT_DID` + `REVDEV_AGENT_PRIVATE_KEY_PEM` env |
| Fallback | revvault `revdev/agents/<agentId>/identity/ed25519-private` |

`backend` on register should name the harness: e.g. `claude-code`, `grok`, `inference-snap`, `ollama`, `mcp-agent`, `studio`.

---

### `session.attach`
**Tier**: Free

Attach to an existing session by ID. Binds the socket to that identity.

**Params**: `{ sessionId?: string, agentId?: string }` (one of the two is required; `agentId` is an alias for `sessionId`)
**Response**: `{ attached: true }`

---

### `session.list`
**Tier**: Free

List active sessions.

**Params**: `{ scope?: 'local' | 'fleet' }` (`local` queries the daemon's own PGlite store; `fleet` queries the Neon-backed cross-machine view)
**Response**: Array of session objects.

---

### `session.update`
**Tier**: Free

Update the current session's task/files description, or self-scoped activity state.

**Params**: `{ task?: string, files?: string, state?: 'active' | 'blocked' | 'idle', blockedReason?: string }` (`state` always applies to the caller's own bound session, never to a targeted `sessionId`/`agentId`)
**Response**: `{ updated: string }` (adds `stateScopedTo` when `state` was set)

---

### `session.end`
**Tier**: Free · **Signature: required**

Self-scoped to the verified Ed25519 signer. The caller may not end another agent’s session via params (the old `sessionId` override was removed). Unsigned frames return an error before the handler runs.

**Params**: `{ exitSummary?: string, summary?: string }` (aliases). Hook clients pass `actorAgentId` only for local identity cache lookup; it is not used as an end-target.

**Response**: `{ ended: string }`

---

## Identity

### `identity.rotate`
**Tier**: Pro
**Signature**: required (proof-of-possession from the CURRENT key)

Rotate a client-owned identity's Ed25519 key. The new key's fingerprint must already be present in the daemon's trust anchor.

**Params**: `{ newPublicKeyPem: string }`
**Response**: identity result including the new DID and public key.

---

## Mail (Inter-Agent Messaging)

### `mail.send`
**Tier**: Pro

Send a message to another agent.

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `to` | string | Recipient agent ID (alias: `toAgent`) |
| `subject` | string | Message subject (max 500 chars) |
| `body` | string | Message body (max 50KB) |

**Response**: `{ sent: true, id: number }`

---

### `mail.inbox`
**Tier**: Pro

Get messages for the calling agent.

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `unreadOnly` | boolean? | Only unread messages (default: true) |

**Response**: `{ messages: Message[] }`

---

### `mail.broadcast`
**Tier**: Pro

Send a message to all active agents (except sender).

**Params**: `{ subject: string, body: string }`
**Response**: `{ broadcast: true, sent: number, recipients: number }`

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
| `ttlSeconds` | number? | Reservation TTL (default: 1800, max: 86400) |
| `reason` | string? | Why the file is reserved |

**Response**: `{ success: boolean, reserved: string[], conflicts: { path, holder }[] }`

---

### `files.check`
**Tier**: Pro

Check reservation status. Only the caller's own reservations are returned in full; a path held by another agent collapses to a boolean so callers cannot learn who holds it.

**Params**: `{ filePath?: string, paths?: string[] }`
**Response**: `{ reservations: Reservation[], reservedByOther: boolean }`

---

### `files.release`
**Tier**: Pro

Release file reservations. Omitting `filePath`/`paths` releases all of the caller's reservations.

**Params**: `{ filePath?: string, paths?: string[] }`
**Response**: `{ released: number }`

---

### `files.list`
**Tier**: Pro

List the calling agent's active file reservations.

**Params**: none
**Response**: `{ reservations: Reservation[] }`

---

## Projects and File I/O

Single-repo file and git access is **Free** — RevDev is meant to be usable as a daily driver without a license. Multi-agent coordination (mail, tasks, files.\* reservations, memory, agent.\*, merge.\*) stays Pro/Max. Every method below is also **Signature: required**.

### `project.open`
**Tier**: Free
**Signature**: required

Register a git repository root the caller owns, so `file.*`/`git.*`/`agent.spawn` can operate inside it. Refuses non-existent paths and repos whose git config carries an exec-bearing key (`filter.*`/`diff.external` etc.).

**Params**: `{ repoPath: string }`
**Response**: `{ success: true, root: string, isGitRepo: boolean }`

---

### `project.grant`
**Tier**: Pro
**Signature**: required

Grant another agent access to a root the caller owns. Only the owner may call this.

**Params**: `{ repoPath: string, granteeAgentId: string }`
**Response**: `{ granted: string, root: string }`

---

### `project.revoke`
**Tier**: Pro
**Signature**: required

Revoke a grantee's access to a root. Blocks future operations (including `agent.spawn`) but does not kill PTY processes the grantee already spawned.

**Params**: `{ repoPath: string, granteeAgentId: string }`
**Response**: `{ revoked: string, root: string }`

---

### `file.read`
**Tier**: Free
**Signature**: required

Read a file inside a registered project root.

**Params**: `{ repoPath: string, filePath: string }`
**Response**: `{ content: string, bytes: number }`, or `{ tooLarge: true, bytes: number }` when the file exceeds the daemon's inline-read cap.

---

### `file.write`
**Tier**: Free
**Signature**: required

Write (create/overwrite) a file inside a registered project root. Refuses `.git/` internals.

**Format enforcement (GAP-309):** when the registered root declares a formatter
(`biome.json` / `biome.jsonc` for JS/TS/JSON/CSS, or `Cargo.toml` for `.rs`), the
daemon **check-and-rejects** unformatted content with `-32007` *before* writing.
It does **not** rewrite the caller's bytes (rewrite would make agents believe
they wrote what they sent). Fix by running the command named in
`error.data.fixCommand` and re-sending. Repos with no formatter config, exempt
paths (`node_modules`, `dist`, …), and non-formatter extensions are unchanged.
CI remains the merge guarantee; this is harness-independent edit-time
enforcement on the daemon path only.

**Params**: `{ repoPath: string, filePath: string, content: string }` (content capped at 768 KiB)
**Response**: `{ success: true, bytes: number }`
**Errors**: `-32007` format rejected (`data.kind = "format-rejected"`, includes `fixCommand`)

---

### `file.delete`
**Tier**: Free
**Signature**: required

Delete a file inside a registered project root. Refuses `.git/` internals.

**Params**: `{ repoPath: string, filePath: string }`
**Response**: `{ success: true }`

---

### `file.stat`
**Tier**: Free
**Signature**: required

Stat a path inside a registered project root.

**Params**: `{ repoPath: string, filePath: string }`
**Response**: `{ exists: true, isFile: boolean, isDirectory: boolean, size: number, mtimeMs: number }`, or `{ exists: false }`

---

## Git

All `git.*` methods operate inside a `project.open`'d root and are **Free** tier, **Signature: required**.

### `git.status`

Porcelain status plus current branch.

**Params**: `{ repoPath: string }`
**Response**: `{ success: true, branch: string | null, files: { status, path }[], clean: boolean }`

---

### `git.diffFile`

Diff a single file (working tree vs. index, or index vs. HEAD when `staged`).

**Params**: `{ repoPath: string, filePath: string, staged?: boolean }`
**Response**: `{ success: true, diff: string }`

---

### `git.diffContent`

The current working-tree content of a file, read directly off disk (for a diff view's "after" pane).

**Params**: `{ repoPath: string, filePath: string }`
**Response**: `{ success: true, content: string, bytes: number }` or `{ success: true, tooLarge: true, bytes: number }`

---

### `git.readBlobAtHead`

The committed (HEAD) content of a file.

**Params**: `{ repoPath: string, filePath: string }`
**Response**: `{ success: true, content: string, bytes: number }` (or `success: false` on error)

---

### `git.readBlobAtIndex`

The staged (index) content of a file.

**Params**: `{ repoPath: string, filePath: string }`
**Response**: `{ success: true, content: string, bytes: number }` (or `success: false` on error)

---

### `git.listBranches`

**Params**: `{ repoPath: string }`
**Response**: `{ success: true, branches: string[], current: string | null }`

---

### `git.log`

**Params**: `{ repoPath: string, limit?: number }` (default 50)
**Response**: `{ success: true, commits: { hash, author, date, timestamp, subject }[] }`

---

### `git.stageFile`

**Params**: `{ repoPath: string, filePath: string }`
**Response**: `{ success: true, stdout: string }` or `{ success: false, error: string, code: number }`

---

### `git.unstageFile`

**Params**: `{ repoPath: string, filePath: string }`
**Response**: same shape as `git.stageFile`

---

### `git.discardFile`

Discard unstaged working-tree edits to a file.

**Params**: `{ repoPath: string, filePath: string }`
**Response**: same shape as `git.stageFile`

---

### `git.createBranch`

**Params**: `{ repoPath: string, name: string, baseBranch?: string }`
**Response**: same shape as `git.stageFile`

---

### `git.switchBranch`

**Params**: `{ repoPath: string, name: string }`
**Response**: same shape as `git.stageFile`

---

### `git.deleteBranch`

**Params**: `{ repoPath: string, name: string, force?: boolean }`
**Response**: same shape as `git.stageFile`

---

### `git.commit`

**Params**: `{ repoPath: string, message: string }`
**Response**: `{ success: true, sha: string, shortSha: string, stdout: string }` or `{ success: false, error: string }`

---

### `git.push`

**Params**: `{ repoPath: string, remote?: string, branch?: string }`
**Response**: same shape as `git.stageFile`

---

### `git.pull`

**Params**: `{ repoPath: string, remote?: string, branch?: string }`
**Response**: same shape as `git.stageFile`

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
| `priority` | 'low' \| 'medium' \| 'high' \| 'critical' ? | Task priority |

**Response**: `{ taskId: string, id: string }`

---

### `tasks.list`
**Tier**: Pro

List tasks with optional filters. Filtering by a specific `owner` requires the caller to BE that owner (verified identity); otherwise only the unfiltered/open pool is visible.

**Params**: `{ status?: string, owner?: string }`
**Response**: `{ tasks: Task[] }`

---

### `tasks.claim`
**Tier**: Pro

Claim an open task. Only one agent can own a task.

**Params**: `{ taskId: string }`
**Response**: `{ success: true, claimed: string, owner: string }` on success, or `{ success: false, claimed: false, owner: string | null, status: string }` if already claimed by someone else.

---

### `tasks.complete`
**Tier**: Pro

Complete a claimed task. Only the owner can complete it.

**Params**: `{ taskId: string, summary?: string }`
**Response**: `{ ok: boolean, completed: string | null }` (`completed` is the taskId on success, `null` if the caller doesn't own the task)

---

### `tasks.release`
**Tier**: Pro

Release a claimed task back to open status.

**Params**: `{ taskId: string }`
**Response**: `{ ok: boolean, released: string | null }` (`released` is the taskId on success, `null` if the caller doesn't own the task)

---

## Events (Audit Log)

### `events.log`
**Tier**: Pro

Log a structured event.

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `eventType` | string | Event type (max 128 chars) |
| `payload` | object? | JSON-serializable payload (max 100KB) |

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

**Response**: `{ stored: string }` (the stored `memoryType`)

---

### `memory.query`
**Tier**: Max

Query stored memories.

**Params**: `{ memoryType?: string, query?: string, tags?: string[], limit?: number }`
**Response**: `{ memories: Memory[] }`

---

## Inference

Interacting with an already-running local model (`inference.status`/`chat`/`generate`) is a **Free** run surface. Model *management* (`pull`/`start`/`stop`) is **Max**. All `inference.*` methods are identity-exempt (no `session.register` required).

### `inference.status`
**Tier**: Free (identity-exempt)

Check Ollama connectivity and loaded models.

**Params**: none
**Response**: `{ running: boolean, url: string, version?: string, models?: { name, sizeMb, modified }[], error?: string }`

---

### `inference.pull`
**Tier**: Max (identity-exempt)

Download a model via Ollama.

**Params**: `{ model: string }`
**Response**: `{ success: true, model: string, status: string }` or `{ success: false, error: string }`

---

### `inference.start` / `inference.stop`
**Tier**: Max (identity-exempt)

Warm up or unload a model.

**Params**: `{ model: string }`
**Response**: `{ loaded: boolean, model?: string, error?: string }` / `{ unloaded: boolean, model?: string, error?: string }`

---

### `inference.chat`
**Tier**: Free (identity-exempt)

Chat completion via Ollama.

**Params**: `{ model: string, messages: { role: 'system' | 'user' | 'assistant', content: string }[], temperature?: number, maxTokens?: number }`
**Response**: `{ message: { role, content }, stats: { totalMs, tokens, tokensPerSecond } }` or `{ error: string }`

---

### `inference.generate`
**Tier**: Free (identity-exempt)

Text generation via Ollama.

**Params**: `{ model: string, prompt: string, system?: string, temperature?: number, maxTokens?: number }`
**Response**: `{ response: string, stats: { totalMs, tokens, tokensPerSecond } }` or `{ error: string }`

---

## Agent Processes

PTY-backed process spawning under the daemon's sandbox. All five methods are **Pro** tier and **Signature: required**; `agent.spawn` additionally requires a `project.open`'d `repoPath` the caller owns or was granted via `project.grant`.

### `agent.spawn`
**Tier**: Pro
**Signature**: required

Spawn a command as a PTY process inside a granted project root, with an allow-listed environment (`TERM`, `LANG`, `LC_*`, `CI`, `NO_COLOR`, `REVDEV_*` only).

**GAP-269 identity:** every spawn mints a distinct key-derived child principal
(`key_origin=spawned`) and returns a one-shot `privateKeyPem`. The child
principal owns the process row; the calling parent remains a supervisor who may
still drive stop/input/resize/output. Siblings cannot drive each other.

**Params**:
| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Binary to run (not allow-listed itself) |
| `args` | string[]? | Command arguments |
| `repoPath` | string | A root the caller owns/was granted (via `project.open`/`project.grant`) |
| `cwd` | string? | Working directory, must resolve inside `repoPath` |
| `cols` / `rows` | number? | PTY size (default 80×24) |
| `env` | object? | Caller env overrides, filtered by the allow-list |

**Response**: `{ processId: string, pid: number, agentId: string, did: string, publicKeyPem: string, privateKeyPem: string, parentAgentId: string }`

---

### `agent.stop`
**Tier**: Pro
**Signature**: required

Send SIGTERM to a live PTY process. Controllers: the child principal or the parent supervisor.

**Params**: `{ processId: string }`
**Response**: `{ stopped: string, status: string }`

---

### `agent.input`
**Tier**: Pro
**Signature**: required

Write bytes to a live PTY's stdin.

**Params**: `{ processId: string, data: string }`
**Response**: `{ written: true }`

---

### `agent.resize`
**Tier**: Pro
**Signature**: required

Resize a live PTY window.

**Params**: `{ processId: string, cols: number, rows: number }`
**Response**: `{ resized: true, cols: number, rows: number }`

---

### `agent.output`
**Tier**: Pro
**Signature**: required

Poll-based output retrieval. There is no server push over this transport; pass the returned cursor back on the next poll.

**Params**: `{ processId: string, cursor?: string, limit?: number }` (limit default 100, max 1000)
**Response**: buffered output chunks since `cursor`, plus process `status`.

---

## Worktrees

### `worktree.create`
**Tier**: Pro
**Signature**: required

Create a git worktree for isolated branch work. The worktree path is daemon-derived (a sibling of the registered root); a caller-supplied path is not honored.

**Params**: `{ repoPath: string, branch: string, baseBranch?: string }` (`baseBranch` defaults to `main`)
**Response**: `{ success: true, branch: string, worktreePath: string, baseBranch: string }` or `{ success: false, error: string }`

---

### `worktree.list`
**Tier**: Pro

List worktrees. Without `agentId`, returns all active worktrees; with it, all worktrees (any status) owned by that agent.

**Params**: `{ agentId?: string }`
**Response**: `{ worktrees: Worktree[] }`

---

### `worktree.remove`
**Tier**: Pro
**Signature**: required

Remove a worktree previously created by the caller for the given `repoPath` + `branch`.

**Params**: `{ repoPath: string, branch: string }`
**Response**: `{ success: true, branch: string, worktreePath: string }` or `{ success: false, error: string }`

---

## Merge Pipeline

### `merge.request`
**Tier**: Pro

Create a merge request (tracked in daemon; PR creation is client-side).

**Params**: `{ sourceBranch: string, baseBranch?: string, taskId?: string, description?: string }` (`sourceBranch` alias: `branch`; `baseBranch` alias: `targetBranch`, defaults to `main`)
**Response**: `{ success: true, mergeId: string, sourceBranch: string, baseBranch: string, status: 'pending' }`

---

### `merge.status`
**Tier**: Pro

Get merge request status.

**Params**: `{ mergeId: string }`
**Response**: `{ found: true, ...MergeRequest }` or `{ found: false }`

---

### `merge.list`
**Tier**: Pro

List merge requests.

**Params**: `{ status?: string, agentId?: string }`
**Response**: `{ mergeRequests: MergeRequest[] }`

---

### `merge.update`
**Tier**: Pro

Update merge request status (e.g., after PR creation or CI result).

**Params**: `{ mergeId: string, status?: string, prNumber?: number, prUrl?: string, errorMessage?: string, ciOutput?: string }`
**Response**: `{ updated: true }`

---

## Error Codes

| Code | Meaning |
|------|---------|
| -32700 | Parse error (malformed JSON, or frame exceeded the max line size) |
| -32601 | Method not found |
| -32602 | Invalid params (Zod validation failed) |
| -32001 | License required (tier too low) |
| -32002 | Identity required (call session.register or session.attach first) |
| -32003 | Signature required (missing or invalid Ed25519 signature on a Signature-required method) |
| -32004 | Untrusted client key (identity enrollment/rotation rejected; fingerprint not in the trust anchor) |
| -32006 | Tool-guard denied (blocked command/path/content) |
| -32007 | Format rejected (GAP-309: content not formatted per repo-declared biome/cargo; see `data.fixCommand`) |
| -32099 | Server is shutting down |
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
| File write content | 768 KiB (786,432 bytes) |
| Event payload | 100 KB |
| Memory content | 500 KB |
| Batch operations | 100-200 items |
| Query limit | 500 rows |
| File TTL | 86,400 seconds (24h) |

Path traversal (`../`) and system paths (`/etc/`, `/proc/`, `/sys/`) are blocked.

`ping`, `identity.rotate`, `project.grant`, and `project.revoke` have no dedicated Zod schema — their params are checked only inside the handler, so malformed extra fields don't produce a -32602; a missing required field surfaces as a generic -32000 handler error instead.
