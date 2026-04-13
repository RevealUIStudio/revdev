# RevDev

Native developer tools for [RevealUI](https://github.com/RevealUIStudio/revealui). One product, two interfaces.

**Studio** — Desktop AI editor and agent coordination dashboard (Tauri 2 + React 19)
**Terminal** — TUI client for API integration, agent management, and deployment (Go + Bubble Tea)

## Architecture

The harness daemon coordinates AI agents, manages PTY sessions, and routes tools. Studio and Terminal are different UIs for the same daemon.

```
┌─────────┐     ┌──────────┐
│  Studio  │     │ Terminal  │
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

Studio and Terminal: MIT
Harness Daemon: FSL-1.1-MIT (Fair Source, converts to MIT after 2 years)
