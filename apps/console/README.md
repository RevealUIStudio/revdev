# RevealUI Console

> **Status: Experimental.** Not production-deployed. A functional prototype.

SSH-delivered TUI for RevealUI account management and licensing. Runs anywhere
there's SSH (phone, borrowed laptop, server) and is explicitly **not** for
editing code (that's Studio's job).

The TUI walks users through: browsing subscription tiers, initiating checkout
(Stripe-hosted URL + QR code), entering a license key, and linking/verifying an
email account via OTP. It can also proxy raw SSH sessions to the RevealUI agent
API (pass `agents` as the SSH command, or set `TERMINAL_MODE=agents`).

Built with the [Charm](https://charm.sh/) ecosystem:

- **Wish** runs the SSH server
- **Bubble Tea** drives the TUI
- **Lip Gloss** handles the terminal styling

## Usage

Once hosted deployment ships, the intended entry point is a single SSH command:

```bash
ssh terminal.revealui.com           # planned, hosted endpoint not yet live
ssh terminal.revealui.com -t agents # agent proxy mode
```

Until then, run locally via the [Development](#development) section.

## Development

Public-key auth is a required allowlist. The process refuses to start without
`CONSOLE_AUTHORIZED_KEYS` pointing at an OpenSSH `authorized_keys` file that
contains at least one key. Default bind is loopback.

```bash
cd apps/console
export CONSOLE_AUTHORIZED_KEYS="$HOME/.ssh/authorized_keys"
go run .
```

## Deployment

Requires persistent TCP (SSH), not serverless. This binary is experimental and
is not a hosted public Console. Default bind is `127.0.0.1`. Publishing the
container port still requires an authorized_keys file; set `HOST` only when you
intentionally expose the listener inside the container:

```bash
docker build -t revealui-console .
docker run \
  -e CONSOLE_AUTHORIZED_KEYS=/keys \
  -v "$HOME/.ssh/authorized_keys:/keys:ro" \
  -p 127.0.0.1:2222:2222 \
  -e HOST=0.0.0.0 \
  revealui-console
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `127.0.0.1` | Bind address (loopback unless set) |
| `PORT` | `2222` | SSH port |
| `HOST_KEY_PATH` | `.ssh/term_ed25519` | SSH host key |
| `CONSOLE_AUTHORIZED_KEYS` | — | Required OpenSSH authorized_keys allowlist; refuse to start if missing or empty |
| `REVEALUI_API_URL` | `https://api.revealui.com` | API endpoint |
| `REVEALUI_API_TOKEN` | — | Optional API token |
