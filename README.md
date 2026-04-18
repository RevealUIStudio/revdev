# RevDev

Native developer tools for [RevealUI](https://github.com/RevealUIStudio/revealui). One product, two interfaces.

**Studio** — Desktop AI editor and agent coordination dashboard (Tauri 2 + React 19)
**Console** — SSH TUI ops cockpit: agent health, deploys, billing, alerts (Go + Bubble Tea)

## Architecture

The harness daemon coordinates AI agents, manages PTY sessions, and routes tools. Studio and Console are different UIs for the same daemon.

```
┌─────────┐     ┌──────────┐
│  Studio  │     │ Console  │
│ (Tauri)  │     │   (Go)   │
└────┬─────┘     └────┬─────┘
     │   JSON-RPC     │
     └───────┬────────┘
             │
     ┌───────┴────────┐
     │  Harness Daemon │
     │   (Node.js)     │
     └───────┬────────┘
             │
     ┌───────┴────────┐
     │  RevealUI API   │
     │  (Hono/Vercel)  │
     └────────────────┘
```

## Status

RevDev is pre-1.0 and the three components have different distribution maturity:

| Component | Status | How to get it today |
|-----------|--------|---------------------|
| Studio | Buildable, unsigned | `pnpm --filter studio tauri build` — produces a local binary. Signed/notarized auto-update pipeline defined in `.github/workflows/studio-release.yml` but not yet cutting public releases. |
| Console | Buildable | `go build -o rvui ./apps/console` — no release automation yet. |
| Harness Daemon | Buildable, not published | Not on npm. Build from source with `pnpm --filter @revdev/daemon build`; run the CLI at `packages/daemon/dist/cli.js`. |

Integration test coverage is thin on the Studio-to-daemon Tauri bridge (`vault.rs`, `spawner.rs`, `harness.rs` commands). Treat Studio as development-preview quality until those land.

## License

Studio and Console: MIT
Harness Daemon: FSL-1.1-MIT (Fair Source, converts to MIT after 2 years)
