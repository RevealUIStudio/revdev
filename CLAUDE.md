# RevDev — Native Developer Tools

Native developer experience for RevealUI. One product, two interfaces.

## Products

| App | Stack | Purpose |
|-----|-------|---------|
| Studio | Tauri 2 + React 19 | Desktop AI editor + agent coordination dashboard |
| Terminal | Go (Bubble Tea) | TUI client — API integration, QR checkout, SSH |

## Architecture

```
RevDev
├── apps/studio/          # Tauri desktop app
├── apps/terminal/        # Go TUI
├── packages/daemon/      # Harness daemon (agent coordination, PTY, tools)
├── packages/protocol/    # JSON-RPC types shared across all apps
└── packages/theme/       # Terminal theme tokens
```

## Relationship to RevealUI

RevDev **consumes** RevealUI packages — it does not contain them:
- `@revealui/contracts` — shared Zod schemas (npm dependency)
- `@revealui/harnesses` — AI harness adapters (npm dependency, Pro)
- RevealUI API — HTTP/WebSocket (Terminal talks directly to API)

The harness daemon is the brain. Studio and Terminal are UIs for it.

## Git Identity
RevealUI Studio <founder@revealui.com>

## Stack
- **Studio**: Rust (Tauri 2 backend) + TypeScript/React 19 (frontend)
- **Terminal**: Go 1.23+ (Bubble Tea TUI framework)
- **Daemon**: TypeScript (Node.js, extracted from @revealui/harnesses)
- **Protocol**: TypeScript (JSON-RPC 2.0 type definitions)

## Commands (planned)

```bash
# Studio
pnpm tauri dev                    # Start Studio in dev mode
pnpm tauri build                  # Build desktop binary

# Terminal
go run ./apps/terminal            # Run Terminal
go build -o rvui ./apps/terminal  # Build Terminal binary

# Daemon
pnpm daemon:dev                   # Start harness daemon
```

## CI Pipelines (planned)

- `studio-release.yml` — Tauri build + code signing + notarization + auto-update (macOS, Windows, Linux)
- `terminal-release.yml` — Go cross-compile + checksums + GitHub Release
- `ci.yml` — Lint + test for both apps
