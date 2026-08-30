# RevDev

> Native developer cockpit for [RevealUI](https://github.com/RevealUIStudio/revealui). One product, three components, vendor-agnostic by design.

| Component | Stack | Purpose |
|---|---|---|
| **Studio** | Tauri 2 + React 19 | Desktop AI editor and agent coordination dashboard |
| **Console** | Go + Bubble Tea | SSH payment + licensing TUI (tiers, checkout, license, email/OTP) + agent-terminal proxy |
| **Harness Daemon** | Node.js | Coordinates AI agents, manages PTY sessions, routes tools |

## Vendor-agnostic by design

RevDev's runtime never imports a vendor AI SDK. AI integration goes through `@revealui/harnesses` adapters with open-model inference as the default — Gemma 4, Ubuntu Inference Snaps, and Ollama. Anthropic, OpenAI, and other vendor SDKs are personal user configuration — not baked into the product.

Per the fleet [agnosticism principle](https://github.com/RevealUIStudio/revealui/blob/main/docs/decisions/2026-05-16-fleet-revealui-native-compliance.md): RevealUI is provider-agnostic; "AI Integration" is a multi-model tier; any single vendor is one variant among many.

## Architecture

```
┌──────────┐     ┌──────────┐
│  Studio  │     │ Console  │
│ (Tauri)  │     │   (Go)   │
└────┬─────┘     └────┬─────┘
     │   JSON-RPC      │ HTTP/WS
     ▼                 ▼
┌──────────────┐  ┌─────────────────┐
│   Harness    │  │  RevealUI API   │
│   Daemon     │  │  (Hono/Vercel)  │
│  (Node.js)   │  └─────────────────┘
└──────┬───────┘
       │ Unix socket JSON-RPC
       ▼
  AI coding tool hooks + other agent runtimes
```

Studio talks to the daemon; the daemon coordinates agents and tools. Console talks to the RevealUI API directly for payment + licensing — it doesn't need the daemon hop.

## Repository layout

```
revdev/
├── apps/studio/          # Tauri 2 desktop app (Studio UI)
├── apps/console/         # Go TUI (Console — SSH payment/licensing TUI + agent proxy)
├── packages/bridge/      # MCP bridge — daemon RPC + fleet kg_* tools (Neon; GAP-349)
├── packages/daemon/      # Harness daemon (agent coordination, PTY, tools)
├── packages/protocol/    # JSON-RPC types shared across all apps
└── packages/theme/       # Console theme tokens
```

Naming: apps are unscoped (`"studio"`, `"console"`) because they're deploy targets, not libraries; packages are scoped (`"@revdev/..."`) because they publish.

## Relationship to RevealUI

RevDev consumes RevealUI packages — it doesn't contain them:

- `@revealui/contracts` — shared Zod schemas
- `@revealui/security` — input sanitization (Studio terminal uses `sanitizeTerminalLine`)
- `@revealui/harnesses` — AI harness adapters (Fair Source)
- `@revealui/presentation` — Studio shims tokens and components through this. Dogfood Phase 1+2 shipped via [revdev#67](https://github.com/RevealUIStudio/revdev/pull/67), [#71](https://github.com/RevealUIStudio/revdev/pull/71), [#73](https://github.com/RevealUIStudio/revdev/pull/73).

The harness daemon is the brain; Studio is its UI. Console is a separate SSH surface talking to the RevealUI API, not the daemon.

## Status

Pre-1.0 across the board:

| Component | Status | How to use it today |
|---|---|---|
| **Studio** | Buildable, unsigned | Local: `pnpm --filter studio tauri build`. Public GitHub Releases are live — latest `studio-v0.2.12` (2026-08-30; macOS · Linux · Windows). Tag pipeline: `.github/workflows/studio-release.yml`. macOS/Windows OS code-signing is still unsigned/ad-hoc (Tauri updater `.sig` files are not Apple/Microsoft signatures). Dogfooding `@revealui/presentation` Phase 1+2+4 done; Phase 3 residual `orange-*` sweep still open. |
| **Console** | Buildable | `cd apps/console && go build -o ../../rvui .`. Tag pipeline: `.github/workflows/console-release.yml`. Public tag `console-v0.2.0` (2026-07-17). |
| **Harness Daemon** | Buildable, not published | Build with `pnpm --filter @revdev/daemon build`. `node packages/daemon/dist/cli.js --detach` returns in <1s; child runs in its own session and PGID. Boot survival via `pnpm --filter @revdev/daemon setup:systemd` (systemd-user unit; requires `loginctl enable-linger` on WSL). |

Integration test coverage is thin on the Studio↔daemon Tauri bridge (`vault.rs`, `spawner.rs`, `harness.rs`). Treat Studio as development-preview quality until those land.

## Commands

```bash
# Studio
pnpm --filter studio tauri:dev    # dev mode
pnpm --filter studio tauri build  # build desktop binary
pnpm typecheck:studio

# Console
cd apps/console && go run .
cd apps/console && go build -o ../../rvui .

# Daemon
pnpm --filter @revdev/protocol build && pnpm --filter @revdev/daemon build
node packages/daemon/dist/cli.js --detach
ls -la ~/.local/share/revealui/harness.sock   # mode srw------- means bound

# Workspace
pnpm -r --filter=!studio build
pnpm test
```

## License

The root [`LICENSE`](./LICENSE) is MIT and is the default for this repository. It does **not** relicense components that declare a different license:

| Component | License | Where declared |
|---|---|---|
| Studio | LicenseRef-RevealUI-Commercial | `apps/studio/src-tauri/Cargo.toml` |
| Console | MIT | root `LICENSE` (no component override) |
| Harness Daemon | FSL-1.1-MIT (Fair Source, converts to MIT after 2 years) | `packages/daemon/LICENSE` |

`@revdev/bridge` is also FSL-1.1-MIT; `@revdev/protocol` and `@revdev/theme` are MIT.
