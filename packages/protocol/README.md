# @revdev/protocol

JSON-RPC 2.0 type definitions shared between Studio, Terminal, and the Harness Daemon.

## Methods

All method name constants are exported as `RPC_METHODS` from `src/methods.ts`.

| Namespace | Methods |
|-----------|---------|
| System | `ping` |
| Harness | `harness.list`, `harness.execute`, `harness.info`, `harness.listRunning`, `harness.syncConfig`, `harness.diffConfig`, `harness.health`, `harness.prune` |
| Sessions | `session.register`, `session.attach`, `session.update`, `session.end`, `session.list`, `session.history` |
| Messaging | `mail.send`, `mail.broadcast`, `mail.inbox`, `mail.markRead` |
| Files | `files.reserve`, `files.check`, `files.release`, `files.list` |
| Tasks | `tasks.create`, `tasks.claim`, `tasks.complete`, `tasks.release`, `tasks.list` |
| Events | `events.log`, `events.query`, `events.wait` |
| Loop guard | `loop.arm`, `loop.tick`, `loop.status` (see below) |
| Agents | `agent.spawn`, `agent.stop`, `agent.input`, `agent.resize` |
| Inference | `inference.status`, `inference.pull`, `inference.start`, `inference.stop` |
| Worktrees | `worktree.create`, `worktree.list`, `worktree.remove` |
| Merge pipeline | `merge.request`, `merge.status`, `merge.list`, `merge.update` |
| Memory | `memory.store`, `memory.query` |

## Loop guard contract (Studio daemon)

Product runtimes that are Studio-attached report loop progress on the harness
socket so LoopGuard can stop a run that is not advancing. Non-Studio paths do
not call these methods. The typed call shape lives in `src/loop-contract.ts`
(`armDaemonLoop`, `tickDaemonLoop`, `statusDaemonLoop`).

Socket: JSON-RPC 2.0, one JSON object per line, default
`~/.local/share/revealui/harness.sock` (`HARNESS_SOCK_DEFAULT`).

| Method | Params | Result |
|---|---|---|
| `loop.arm` | `loopId`, `intervalMs`, optional `noopLimit` (1..100), optional `sessionId` | `{ loop, stop, noopLimit }` |
| `loop.tick` | `loopId`, `advanced` (boolean, required), optional `tokensIn`, `tokensOut`, `costMicros` | `{ loop, stop, noopLimit }` |
| `loop.status` | `loopId` | `{ loop, stop, noopLimit }`. `loop` is null when missing or reaped |

`noopLimit` defaults to **3** (`DEFAULT_LOOP_NOOP_LIMIT`) when arm omits it.
Each `loop.tick` counts. After 3 consecutive `advanced: false` ticks, `loop.status`
is `not_advancing` and `stop` is true. The caller stops. An unknown `loopId` on
tick is an error. A missing `advanced` flag is an error, not a dropped tick.

`loop.arm` requires the caller's live session. The loop is reaped on
`session.end` and on `harness.prune` (same session-end hook). After reap,
`loop.status` returns `loop: null` and `loop.tick` errors.

Identity matches other routine coordination calls: pass `actorAgentId` for a
daemon-minted session, or sign the frame for a client-owned identity.

```json
{"jsonrpc":"2.0","id":1,"method":"loop.arm","params":{"loopId":"task-1","intervalMs":120000,"actorAgentId":"agent-1"}}
{"jsonrpc":"2.0","id":2,"method":"loop.tick","params":{"loopId":"task-1","advanced":false,"actorAgentId":"agent-1"}}
{"jsonrpc":"2.0","id":3,"method":"loop.status","params":{"loopId":"task-1","actorAgentId":"agent-1"}}
```
