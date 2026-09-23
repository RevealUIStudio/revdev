# Key Generation — RevDev Production Setup

Run these commands to generate the signing keys needed for commercial release.
All keys are stored in revvault (encrypted at rest).

---

## 1. Tauri Updater Signing Key

Signs Studio desktop binaries for auto-update verification.

> **STATUS: DONE 2026-06-11.** The keypair exists and is stored in revvault (exact store paths are kept in the internal key index, not this public runbook); the public key is embedded in `apps/studio/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`; the `TAURI_SIGNING_PRIVATE_KEY{,_PASSWORD}` repo secrets are set.
>
> **Re-running this section ROTATES the key.** Installed Studio builds verify updates against the embedded public key — a new keypair orphans every existing install until it manually reinstalls. Only rotate on compromise, and treat it as a breaking release event.

```bash
# Generate in tmpfs so the private key never lands on persistent disk,
# with a random password (no interactive prompt):
D=/dev/shm/h1-tauri && mkdir -m 700 "$D"
openssl rand -base64 24 > "$D/pw"
cd ~/revealfleet/revdev/apps/studio
node_modules/.bin/tauri signer generate -w "$D/revdev-studio.key" --password "$(cat "$D/pw")"

# Vault all three (revvault set reads stdin). Substitute the real revvault
# paths from the internal key index for the placeholders below.
revvault set <tauri-signing-private-key path>          < "$D/revdev-studio.key"
revvault set <tauri-signing-private-key-password path> < "$D/pw"
revvault set <tauri-signing-public-key path>           < "$D/revdev-studio.key.pub"

# Mirror to CI secrets, then shred
gh secret set TAURI_SIGNING_PRIVATE_KEY          -R RevealUIStudio/revdev < "$D/revdev-studio.key"
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R RevealUIStudio/revdev < "$D/pw"
shred -u "$D/pw" "$D/revdev-studio.key" && rm -rf "$D"
```

**After**: wire the public key (`revdev-studio.key.pub` content) into `tauri.conf.json` → `plugins.updater.pubkey`.

---

## 2. License Signing Key (Ed25519)

Signs customer license keys (Ed25519-signed JWTs — the daemon rejects legacy `RVUI.v2.*` / `RVUI-*` formats) so the daemon can verify them. <!-- doclint:allow-legacy-format -->

```bash
# Mint Ed25519 keypair; auto-stores both halves in revvault (exact store paths
# are kept in the internal key index) and prints the public PEM.
# No plaintext key files ever land on disk.
cd ~/revealfleet/revdev
npx tsx scripts/issue-license.ts --generate-keypair

# Wire the public key into the local daemon's environment.
echo 'export REVDEV_LICENSE_PUBLIC_KEY="$(revvault get --full revdev/license-signing-public-key)"' >> ~/.bashrc
export REVDEV_LICENSE_PUBLIC_KEY="$(revvault get --full revdev/license-signing-public-key)"
```

---

## 3. Issue a Test License

Verify the key works by issuing yourself an enterprise license:

```bash
cd ~/revealfleet/revdev
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

Add these to RevealUIStudio/revdev → Settings → Secrets → Actions.

`.github/workflows/studio-release.yml` **reads these names**. It does not contain certificate bytes and it does not generate certificates. An empty secret leaves that platform unsigned. A non-empty certificate secret is passed through (macOS) or imported for Authenticode (Windows).

| Secret | Value Source | Status |
|--------|-------------|--------|
| `TAURI_SIGNING_PRIVATE_KEY` | revvault — Tauri signing private key (see internal key index) | ✅ set 2026-06-11 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | revvault — Tauri signing private-key password (see internal key index) | ✅ set 2026-06-11 |

macOS Developer ID + notarization. Set the required names together. If `APPLE_CERTIFICATE` is empty, the macOS build stays unsigned.

| Secret | Required | Value Source |
|--------|----------|-------------|
| `APPLE_CERTIFICATE` | yes, to sign | Base64 `.p12` exported from the Developer ID Application certificate |
| `APPLE_CERTIFICATE_PASSWORD` | yes, with the certificate | `.p12` password |
| `APPLE_SIGNING_IDENTITY` | no | Keychain identity. When empty, Tauri uses the identity inside the `.p12` |
| `APPLE_ID` | yes, to notarize | Apple ID email |
| `APPLE_PASSWORD` | yes, to notarize | App-specific password |
| `APPLE_TEAM_ID` | yes, to notarize | Apple Developer Team ID |

Windows Authenticode. Set both together. If `WINDOWS_CERTIFICATE` is empty, the Windows build stays unsigned. The workflow reads the thumbprint from the imported certificate at build time; it is not stored in the repo.

| Secret | Value Source |
|--------|-------------|
| `WINDOWS_CERTIFICATE` | Base64 `.pfx` (`certutil -encode certificate.pfx out.txt`, or raw base64) |
| `WINDOWS_CERTIFICATE_PASSWORD` | `.pfx` export password |

---

## After All Keys Are Set

The updater public key is already in `tauri.conf.json`. OS code signing is already wired to the secret names above. Do not generate certificates. After those secrets are set, tag a `studio-v*` release and confirm the macOS and Windows jobs sign.
