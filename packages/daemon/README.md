# @revdev/daemon

Harness daemon — the coordination brain for RevDev.

Manages AI agent sessions, PTY processes, tool routing, inter-agent messaging, task coordination, and file reservations.

## Transport

- **Local**: Unix socket (`~/.local/share/revealui/harness.sock`)
- **Remote**: HTTP gateway with pairing-code auth
- **Protocol**: JSON-RPC 2.0 over newline-delimited JSON

## Extraction status

Being extracted from `@revealui/harnesses` in the RevealUI monorepo. The daemon will be a standalone Node.js process that Studio and Terminal connect to.
