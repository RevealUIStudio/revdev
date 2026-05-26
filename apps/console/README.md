# RevealUI Console

> **Status: Experimental** — Not production-deployed. Functional prototype.

SSH-delivered TUI for RevealUI account management and licensing. Runs anywhere
there's SSH — phone, borrowed laptop, server — and is explicitly **not** for
editing code (that's Studio's job).

The TUI walks users through: browsing subscription tiers, initiating checkout
(Stripe-hosted URL + QR code), entering a license key, and linking/verifying an
email account via OTP. It can also proxy raw SSH sessions to the RevealUI agent
API (pass `agents` as the SSH command, or set `TERMINAL_MODE=agents`).

Built with the [Charm](https://charm.sh/) ecosystem:

- **Wish** — SSH server
- **Bubble Tea** — TUI framework
- **Lip Gloss** — Terminal styling

## Usage

The intended entry point — once hosted deployment ships — is a single SSH command:

```bash
ssh terminal.revealui.com           # planned — hosted endpoint not yet live
ssh terminal.revealui.com -t agents # agent proxy mode
```

Until then, run locally via the [Development](#development) section.

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
