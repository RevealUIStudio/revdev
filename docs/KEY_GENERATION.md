# Key Generation — RevDev Production Setup

Run these commands to generate the signing keys needed for commercial release.
All keys are stored in revvault (encrypted at rest).

---

## 1. Tauri Updater Signing Key

Signs Studio desktop binaries for auto-update verification.

> **STATUS: DONE 2026-06-11.** The keypair exists. Private key, password, and public key live in revvault at `revdev/tauri-signing-{private-key,private-key-password,public-key}`; the public key is embedded in `apps/studio/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`; the `TAURI_SIGNING_PRIVATE_KEY{,_PASSWORD}` repo secrets are set.
>
> **Re-running this section ROTATES the key.** Installed Studio builds verify updates against the embedded public key — a new keypair orphans every existing install until it manually reinstalls. Only rotate on compromise, and treat it as a breaking release event.

```bash
# Generate in tmpfs so the private key never lands on persistent disk,
# with a random password (no interactive prompt):
D=/dev/shm/h1-tauri && mkdir -m 700 "$D"
openssl rand -base64 24 > "$D/pw"
cd ~/revfleet/revdev/apps/studio
node_modules/.bin/tauri signer generate -w "$D/revdev-studio.key" --password "$(cat "$D/pw")"

# Vault all three (revvault set reads stdin)
revvault set revdev/tauri-signing-private-key          < "$D/revdev-studio.key"
revvault set revdev/tauri-signing-private-key-password < "$D/pw"
revvault set revdev/tauri-signing-public-key           < "$D/revdev-studio.key.pub"

# Mirror to CI secrets, then shred
gh secret set TAURI_SIGNING_PRIVATE_KEY          -R RevealUIStudio/revdev < "$D/revdev-studio.key"
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R RevealUIStudio/revdev < "$D/pw"
shred -u "$D/pw" "$D/revdev-studio.key" && rm -rf "$D"
```

**After**: wire the public key (`revdev-studio.key.pub` content) into `tauri.conf.json` → `plugins.updater.pubkey`.

---

## 2. License Signing Key (Ed25519)

Signs customer license keys (Ed25519-signed JWTs — the daemon rejects legacy `RVUI.v2.*` / `RVUI-*` formats) so the daemon can verify them.

```bash
# Mint Ed25519 keypair; auto-stores both halves in revvault at
# revdev/license-signing-{private,public}-key and prints the public PEM.
# No plaintext key files ever land on disk.
cd ~/revfleet/revdev
npx tsx scripts/issue-license.ts --generate-keypair

# Wire the public key into the local daemon's environment.
echo 'export REVDEV_LICENSE_PUBLIC_KEY="$(revvault get --full revdev/license-signing-public-key)"' >> ~/.bashrc
export REVDEV_LICENSE_PUBLIC_KEY="$(revvault get --full revdev/license-signing-public-key)"
```

---

## 3. Issue a Test License

Verify the key works by issuing yourself an enterprise license:

```bash
cd ~/revfleet/revdev
npx tsx scripts/issue-license.ts --tier enterprise --perpetual
```

Set the output as your license key:

```bash
export REVEALUI_LICENSE_KEY="<paste key from above>"
echo 'export REVEALUI_LICENSE_KEY="<paste key>"' >> ~/.bashrc
systemctl --user restart revdev-daemon
journalctl --user -u revdev-daemon | tail -5
# Should show: "running with ENTERPRISE license"
```

---

## 4. Verify End-to-End

Test a licensed RPC call:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tasks.create","params":{"title":"test task"}}' | \
  socat - UNIX-CONNECT:~/.local/share/revealui/harness.sock
# Success: returns { taskId: ... }
# Failure: returns -32001 License required
```

---

## 5. GitHub Secrets (for CI)

Add these to RevealUIStudio/revdev → Settings → Secrets → Actions:

| Secret | Value Source | Status |
|--------|-------------|--------|
| `TAURI_SIGNING_PRIVATE_KEY` | `revvault get --full revdev/tauri-signing-private-key` | ✅ set 2026-06-11 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `revvault get --full revdev/tauri-signing-private-key-password` | ✅ set 2026-06-11 |

macOS-only (when ready for Apple distribution):
| Secret | Value Source |
|--------|-------------|
| `APPLE_CERTIFICATE` | Base64 .p12 from Apple Developer |
| `APPLE_CERTIFICATE_PASSWORD` | .p12 password |
| `APPLE_ID` | founder@revealui.com |
| `APPLE_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

---

## After All Keys Are Set

Tell Claude Code: "keys are generated" — it will:
1. Wire Tauri public key into `tauri.conf.json`
2. Tag `studio-v0.1.0` for first signed release
3. Verify CI builds succeed with signing
