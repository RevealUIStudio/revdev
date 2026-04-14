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

## License

Studio and Console: MIT
Harness Daemon: FSL-1.1-MIT (Fair Source, converts to MIT after 2 years)
