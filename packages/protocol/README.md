# @revdev/protocol

JSON-RPC 2.0 type definitions shared between Studio, Terminal, and the Harness Daemon.

## Methods

| Method | Description |
|--------|-------------|
| `agent.list` | List active agent sessions |
| `agent.spawn` | Start a new agent session |
| `agent.stop` | Stop an agent session |
| `agent.input` | Send input to agent PTY |
| `agent.resize` | Resize agent terminal |
| `tasks.create` | Create a coordination task |
| `tasks.claim` | Claim a task (atomic CAS) |
| `tasks.complete` | Mark task complete |
| `tasks.release` | Release task ownership |
| `tasks.list` | List tasks with filters |
| `messages.send` | Send inter-agent message |
| `messages.list` | List messages for agent |
| `files.reserve` | Reserve file for editing |
| `files.release` | Release file reservation |
