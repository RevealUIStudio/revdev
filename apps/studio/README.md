# RevealUI Studio

> **Status:** Functional — connects to the harness daemon, 506 frontend tests passing. **Prebuilt binaries are published** on [GitHub Releases](https://github.com/RevealUIStudio/revdev/releases) (first release `studio-v0.1.0`, 2026-07-02; macOS · Linux · Windows). macOS builds are currently **unsigned / ad-hoc**, so Gatekeeper blocks the first launch — **right-click the app → Open** (or `System Settings → Privacy & Security → Open Anyway`) once to run it. In-app auto-update is **configured but not yet live** (the `releases.revealui.com` update endpoint is not serving manifests yet), so update by downloading the latest release manually for now. To run from source instead: `pnpm tauri:dev`.

Native AI experience — agent coordination hub, local inference management, visual agent dashboard, DevPod manager, and secret vault.

Built with Tauri 2 + React 19 + Tailwind CSS v4.

## Features

- **Dashboard** — Service status overview with tier badge and mount status
- **Vault** — Secret management via Revvault (age encryption), namespace filtering, clipboard integration
- **Infrastructure** — App launcher (start/stop/read logs) + DevPod mount/unmount
- **Sync** — Repository sync across locations (WSL, LTS, DevPod)
- **Tunnel** — Tailscale status, connect/disconnect, peer list with 10s polling
- **Setup** — First-run wizard (environment check, vault init, Tailscale, git identity)
- **SSH** — SSH client with password/key auth, bookmarks (save/list/delete), interactive terminal
- **Terminal** — Local PTY shell sessions (open/send/resize/close) + terminal emulator detection/install
- **Git** — Full git workflow: status, diff, stage/unstage, discard, commit, branch management (create/switch/delete), push/pull, log, read/write files, diff content
- **Deploy** — One-click deploy pipeline: Vercel (project create, env set, deploy, deployment status, blob token validate), Neon DB (test connection, migrate, seed), Stripe (validate keys, seed, run keys, catalog sync), email (Resend + SMTP test), health check, secret generation (KEK, RSA keypair)
- **Harness** — Harness daemon coordination: ping, sessions, inbox, send/broadcast messages, mark-read, tasks (create/claim/complete/release), file reservations (reserve/check)
- **Agent Spawner** — Spawn/stop/list/remove agent PTY sessions with input/resize
- **Inference** — Ollama management (status, models, pull, delete, start, stop) + Ubuntu Snap inference (status, list, install, remove)
- **Daemon Control** — Start/stop/restart/status of the harness daemon process

## Stack

- **Desktop**: Tauri 2
- **UI**: React 19 + Tailwind CSS v4
- **Backend**: Rust (PlatformOps trait with Windows/WSL implementation)
- **Vault**: revvault-core + age encryption + secrecy
- **Tunnel**: Tailscale CLI integration

## Development

```bash
# Start Vite dev server (frontend only)
pnpm dev

# Start Tauri dev (frontend + Rust backend)
pnpm tauri:dev

# Build for production
pnpm tauri:build

# Build Windows installer
pnpm build:windows
```

## Architecture

```
apps/studio/
├── src/                    # React frontend
│   ├── App.tsx
│   ├── generated/          # ts-rs bindings (Git*, Harness*, Ollama*, Snap*, Ssh*, Deploy*, Agent*, …)
│   └── lib/invoke.ts       # Typed Tauri command wrappers
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── commands/       # Tauri commands (agent, apps, config, deploy, git, harness,
│   │   │                   #   inference, launcher, local_shell, mount, setup, spawner,
│   │   │                   #   ssh, status, sync, terminal, tunnel, vault)
│   │   ├── platform/       # PlatformOps trait + OS implementations
│   │   ├── config.rs       # App config state
│   │   ├── daemon_ctl.rs   # Harness daemon process control
│   │   ├── harness.rs      # Harness connection state
│   │   ├── harness_watcher.rs # Daemon health watcher
│   │   ├── inference.rs    # Ollama + Snap inference management
│   │   ├── local_shell.rs  # Local PTY shell sessions
│   │   ├── spawner.rs      # Agent spawner (PTY per agent)
│   │   ├── ssh.rs          # SSH client (russh)
│   │   ├── state.rs        # Managed AppState
│   │   ├── tray.rs         # System tray
│   │   ├── updater.rs      # Auto-updater (tauri-plugin-updater)
│   │   └── lib.rs          # Plugin registration + invoke_handler
│   └── Cargo.toml
└── package.json
```

## Rust Backend

The Rust backend uses a `PlatformOps` trait for cross-platform operations:

- **Windows/WSL**: Shells out to `wsl.exe`, `pwsh.exe`, `git` for WSL operations
- **Linux/macOS**: Direct system calls (stubs for now)

App management uses `ss -tlnp` for status detection and `fuser -k PORT/tcp` for stopping.

Key Rust crates: `russh` 0.60 (SSH client), `portable-pty` (PTY sessions), `git2` 0.20 (vendored, git operations), `revvault-core` (vault), `age` 0.11 + `secrecy` (encryption), `lettre` (SMTP email), `ts-rs` (TypeScript binding generation), `tauri-plugin-updater` (auto-update), `reqwest` with rustls (HTTP).

## Related

- [Architecture Guide](../../docs/ARCHITECTURE.md)
- [Distribution Guide](../../.claude/rules/distribution.md)

## License

LicenseRef-RevealUI-Commercial (see `src-tauri/Cargo.toml`)
