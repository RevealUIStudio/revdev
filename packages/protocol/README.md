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
| Events | `events.log`, `events.query` |
| Agents | `agent.spawn`, `agent.stop`, `agent.input`, `agent.resize` |
| Inference | `inference.status`, `inference.pull`, `inference.start`, `inference.stop` |
| Worktrees | `worktree.create`, `worktree.list`, `worktree.remove` |
| Merge pipeline | `merge.request`, `merge.status`, `merge.list`, `merge.update` |
| Memory | `memory.store`, `memory.query` |
