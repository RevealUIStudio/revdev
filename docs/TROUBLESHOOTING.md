# Troubleshooting

Common issues and fixes for RevDev Studio and the Harness Daemon.

---

## Daemon Won't Start

### Socket already in use

```
Error: listen EADDRINUSE: address already in use ~/.local/share/revealui/harness.sock
```

Another daemon instance is running, or a stale socket exists.

```bash
# Check if daemon is running
systemctl --user status revdev-daemon

# If running, restart instead
systemctl --user restart revdev-daemon

# If not running, remove stale socket
rm ~/.local/share/revealui/harness.sock
systemctl --user start revdev-daemon
```

### PID file exists but process is dead

```bash
# Remove stale PID file
rm ~/.local/share/revealui/harness.pid

# Start daemon
systemctl --user start revdev-daemon
```

### Permission denied on socket

The daemon creates its socket with mode 0600 (owner-only). If you see permission errors:

```bash
# Check socket ownership
ls -la ~/.local/share/revealui/harness.sock

# Ensure you're running as the correct user
whoami
```

### Node.js version too old

The daemon requires Node.js 24+. Check your version:

```bash
node --version
# Must be v24.x or higher
```

---

## Studio Can't Connect to Daemon

### Status shows "Disconnected"

1. Check if daemon is running: `systemctl --user status revdev-daemon`
2. Check socket exists: `ls -la ~/.local/share/revealui/harness.sock`
3. Test connectivity manually:
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}' | \
     socat - UNIX-CONNECT:~/.local/share/revealui/harness.sock
   ```

### Status shows "Connecting..." indefinitely

Studio retries with exponential backoff (2s, 4s, 8s... up to 30s). If it never connects:

1. The daemon may be crashing on startup — check logs:
   ```bash
   journalctl --user -u revdev-daemon --no-pager | tail -50
   ```
2. Look for database errors (PGlite) or license issues

### Studio works but operations fail with "License required"

You're on the Free tier. Set `REVEALUI_LICENSE_KEY` and restart the daemon. See [Getting Started](./GETTING_STARTED.md#license-activation).

---

## License Issues

### "running in FREE (degraded) mode"

No valid license key detected. Set `REVEALUI_LICENSE_KEY` in your environment:

```bash
export REVEALUI_LICENSE_KEY="eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9..."
systemctl --user restart revdev-daemon
```

The daemon ships with the vendor public key baked in, so this is normally all you need. `REVDEV_LICENSE_PUBLIC_KEY` is only for key rotation or testing your own keypair; see "License key doesn't activate" below if the key is valid but still shows Free.

<!-- doclint:allow-legacy-format:start — this section documents the REJECTED formats on purpose -->
### Old-format key (`RVUI-*` or `RVUI.v2.*`) rejected

Both the v1 (`RVUI-pro-...`) and the dotted-v2 (`RVUI.v2.pro....`) formats
are rejected. The daemon writes this exact line to stderr (visible in
`journalctl --user -u revdev-daemon`) and then stays in Free mode:

```
[revdev] Legacy license formats (RVUI.v2.*, RVUI-*) are no longer accepted. Mint an Ed25519-signed JWT via the RevealUI license API or `revdev/scripts/issue-license.ts`.
```

Current keys are Ed25519-signed JWTs starting with `eyJ`. Contact
support@revealui.com for a current key. (A non-legacy key that fails for
another reason logs `[revdev] License validation failed: <reason>` instead.)
<!-- doclint:allow-legacy-format:end -->

### License key doesn't activate

Verify the key format:
```bash
echo $REVEALUI_LICENSE_KEY
# Must start with eyJ
# Format: a three-part base64url JWT <header>.<payload>.<signature> (alg: EdDSA)
```

If the key is valid but still shows Free:
- Ensure `REVDEV_LICENSE_PUBLIC_KEY` is set (the daemon needs the public key to verify signatures)
- Check daemon logs: `journalctl --user -u revdev-daemon | grep license`

---

## Database Issues

### Daemon crashes on startup with PGlite error

The database may be corrupted. Back up and recreate:

```bash
# Stop daemon
systemctl --user stop revdev-daemon

# Back up the entire data directory (see the warning below — this is not
# just the database)
mv ~/.local/share/revealui ~/.local/share/revealui.bak

# Start daemon (creates fresh database)
systemctl --user start revdev-daemon
```

**Warning — wider blast radius than the database alone.** `~/.local/share/revealui`
is the whole daemon data directory, not just PGlite. Moving it discards
**everything** under it: all session history, tasks, and file reservations,
agent memory and merge-request history, **and** the harness socket
(`harness.sock`), the PID file (`harness.pid`), and any sidecar/runtime state.
Only do this with the daemon stopped (as above); the fresh start recreates the
socket and PID file. If you want to reset *only* the database, scope the move
to the PGlite subdirectory rather than the entire `revealui` directory.

### Database grows too large

Check database size:
```bash
du -sh ~/.local/share/revealui/
```

The daemon stores all events, messages, and memory in PGlite. If the database exceeds 500MB:
1. Old events can be manually cleaned (not yet automated)
2. Consider backing up and recreating for a fresh start

---

## Auto-Update Issues

### "Update check failed"

Studio checks `releases.revealui.com` for updates. If this fails:
- Check internet connectivity
- The update server may be temporarily unavailable
- Studio continues working normally without updates

### Update signature verification failed

This means the downloaded update binary was tampered with or corrupted. **Do not install it.** Download manually from [GitHub Releases](https://github.com/RevealUIStudio/revdev/releases).

---

## Performance Issues

### Daemon using too much memory

Check memory usage:
```bash
systemctl --user status revdev-daemon | grep Memory
```

The daemon has a 512MB memory limit by default. If it exceeds this:
1. Many active sessions or large event payloads can cause growth
2. Restart the daemon to release memory: `systemctl --user restart revdev-daemon`
3. The daemon health endpoint reports memory: call `harness.health` with `detailed: true`

### Slow RPC responses

All RPC calls are tracked with Prometheus metrics. Check latency:

```bash
# Via RPC (requires license)
echo '{"jsonrpc":"2.0","id":1,"method":"harness.health","params":{"metrics":true}}' | \
  socat - UNIX-CONNECT:~/.local/share/revealui/harness.sock
```

Look for `revdev_daemon_rpc_duration_seconds` histogram — if p99 > 1s, the database may need maintenance.

---

## macOS-Specific Issues

### "RevealUI Studio is damaged and can't be opened"

The app needs to be notarized. If you downloaded from GitHub Releases and see this:

```bash
xattr -cr /Applications/RevealUI\ Studio.app
```

### Daemon doesn't start via launchd

Check launchd logs:
```bash
tail -f /tmp/revealui-daemon.log
tail -f /tmp/revealui-daemon.err
```

Verify the plist is loaded:
```bash
launchctl list | grep revealui
```

---

## Getting Help

- [GitHub Issues](https://github.com/RevealUIStudio/revdev/issues) — bug reports and feature requests
- Email: support@revealui.com
