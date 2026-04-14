# RevealUI Console

> **Status: Experimental** — Not production-deployed. Functional prototype.

SSH-delivered TUI ops cockpit for RevealUI. Read-mostly view of agent health,
deploys, billing, and alerts; fast keyboard ops for rollback, approve, rotate,
ack, and credit purchases. Runs anywhere there's SSH — phone, borrowed laptop,
server — and is explicitly **not** for editing code (that's Studio's job).

Built with the [Charm](https://charm.sh/) ecosystem:

- **Wish** — SSH server
- **Bubble Tea** — TUI framework
- **Lip Gloss** — Terminal styling

## Usage

```bash
ssh console.revealui.com
```

## Development

```bash
cd apps/console
go run .
```

## Deployment

Requires persistent TCP (SSH), not serverless. Deploy to Fly.io or a VPS:

```bash
docker build -t revealui-console .
docker run -p 2222:2222 revealui-console
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `2222` | SSH port |
| `HOST_KEY_PATH` | `.ssh/term_ed25519` | SSH host key |
| `REVEALUI_API_URL` | `https://api.revealui.com` | API endpoint |
| `REVEALUI_API_TOKEN` | — | Optional API token |
