# Key Generation — RevDev Production Setup

Run these commands to generate the signing keys needed for commercial release.
All keys are stored in revvault (encrypted at rest).

---

## 1. Tauri Updater Signing Key

Signs Studio desktop binaries for auto-update verification.

```bash
# Generate keypair (prompts for a password)
cd ~/suite/revdev/apps/studio/src-tauri
npx @tauri-apps/cli signer generate -w ~/.tauri/revdev-studio.key

# Store in revvault
revvault set revdev/tauri-signing-private-key < ~/.tauri/revdev-studio.key
revvault set revdev/tauri-signing-password
# ^ enter the password you chose during generation

# Copy the PUBLIC KEY printed during generation — needed for tauri.conf.json
# It looks like: dW50cnVzdGVkIGNvbW1lbnQ6...
```

**After**: Give the public key to Claude Code to wire into `tauri.conf.json`.

---

## 2. License Signing Key (Ed25519)

Signs customer license keys (RVUI.v2 format) so the daemon can verify them.

```bash
# Generate Ed25519 keypair
openssl genpkey -algorithm ed25519 -out /tmp/license-private.pem
openssl pkey -in /tmp/license-private.pem -pubout -out /tmp/license-public.pem

# Store in revvault
revvault set revdev/license-signing-private-key < /tmp/license-private.pem
revvault set revdev/license-signing-public-key < /tmp/license-public.pem

# Set public key for local daemon
export REVDEV_LICENSE_PUBLIC_KEY="$(cat /tmp/license-public.pem)"
echo 'export REVDEV_LICENSE_PUBLIC_KEY="$(revvault get --full revdev/license-signing-public-key)"' >> ~/.bashrc

# Clean up plaintext
rm /tmp/license-private.pem /tmp/license-public.pem
```

---

## 3. Issue a Test License

Verify the key works by issuing yourself an enterprise license:

```bash
cd ~/suite/revdev
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

| Secret | Value Source |
|--------|-------------|
| `TAURI_SIGNING_PRIVATE_KEY` | `revvault get --full revdev/tauri-signing-private-key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `revvault get --full revdev/tauri-signing-password` |

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
