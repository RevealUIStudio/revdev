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
├── apps/studio/          # Tauri desktop app (Studio UI)
├── apps/terminal/        # Go TUI (RevDev Terminal)
├── packages/bridge/      # Thin adapter layer between daemon + apps
├── packages/daemon/      # Harness daemon (agent coordination, PTY, tools)
├── packages/protocol/    # JSON-RPC types shared across all apps
└── packages/theme/       # Terminal theme tokens
```

## Naming Convention

Monorepo-wide split on `package.json` `name` fields:
- **Apps** (`apps/*`): unscoped — `"studio"`, `"terminal"`. Never `@scope/<app>`.
- **Packages** (`packages/*`): scoped — `"@revdev/daemon"`, `"@revdev/protocol"`.

Rationale: apps are deploy targets, not consumable libraries; the `@scope/` prefix is reserved for things that get published.

## Relationship to RevealUI

RevDev **consumes** RevealUI packages — it does not contain them:
- `@revealui/contracts` — shared Zod schemas (npm dependency)
- `@revealui/security` — shared security primitives incl. input sanitization (npm dependency; studio terminal uses `sanitizeTerminalLine`)
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

## Commands

```bash
# Studio
pnpm --filter studio tauri:dev    # Start Studio in dev mode
pnpm --filter studio tauri build  # Build desktop binary
pnpm typecheck:studio             # Typecheck Studio frontend

# Terminal
go run ./apps/terminal            # Run Terminal
go build -o rvui ./apps/terminal  # Build Terminal binary

# Workspace
pnpm -r --filter=!studio build    # Build all packages (skip Tauri)
pnpm test                         # Run tests
```

## CI Pipelines

- `studio-release.yml` — Tauri build + code signing + notarization + auto-update (macOS, Windows, Linux)
- `terminal-release.yml` — Go cross-compile + checksums + GitHub Release
- `ci.yml` — Lint + test for both apps
