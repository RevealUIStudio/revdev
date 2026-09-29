# Windows + WSL daemon_setup smoke

Runtime smoke for the Windows Studio `daemon_setup` path: stage the Linux relay inside WSL, `systemctl --user enable` the `revdev-daemon` unit, write the trust anchor with `sudo tee`, then `session.register` and a signed `file.write` round trip.

This smoke must be run by the owner on the Windows + WSL laptop. A CI runner has no WSL distro and cannot perform it. Record the result in the table at the end of this file (copy the table into the run notes; do not commit the filled-in table).

Do not start the daemon until the owner confirms the environment in [Before any start](#before-any-start). The unit's `ExecStartPre` hooks, when a drop-in is installed, read secrets from the vault. The example drop-in `packages/daemon/systemd/postgres-url-file.conf.example` reads a production database URL. This smoke uses the documented test profile below and never a production one. Nothing in this runbook is authorization to start a unit that still points at production.

Source of the commands (do not treat this doc as a second implementation):

- `apps/studio/src-tauri/src/daemon_ctl.rs`: `wsl::distro`, `wsl::run`, `wsl::systemctl`, `wsl::ensure_systemd`, `daemon_setup`, `build_trust_anchor_provision_script`
- `apps/studio/src-tauri/src/win_process.rs`: `relay_shell_command`
- `apps/studio/src-tauri/src/harness.rs`: socket relative path, `session.register` params, signed `rpc_call`
- `apps/studio/src-tauri/src/signing.rs`: identity file path, anchor grammar
- `apps/studio/src-tauri/wsl/README.md`: how the Linux relay ELF is built
- `packages/daemon/systemd/revdev-daemon.service` and `install.sh`: unit install. `install.sh` ends in `enable --now`, which this smoke does not run
- `packages/daemon/README.md` section "Smoke test", configuration table, and `packages/daemon/src/neon.ts`: test profile (no production database URL)
- `packages/daemon/src/__tests__/filegit-signed.test.ts`: signed `project.open` / `file.write` / `file.read` round trip

## Who runs it, and what not to record

- Runner: the owner, on the Windows + WSL laptop, interactively.
- Distro: `REVDEV_WSL_DISTRO` if set, otherwise `Ubuntu` (`wsl::distro` in `daemon_ctl.rs`). Commands below use `Ubuntu`. Substitute the other name in every `wsl.exe -d` argument when the override is set.
- Repo checkout used for the build must live on the WSL ext4 filesystem (the WSL home), not on `/mnt/c`.
- Do not put secrets, tokens, license JWTs, vault values, database URLs, the signing seed, or the fingerprint in the results table, in shell history notes, or in chat. The identity file `%LOCALAPPDATA%\revealui-studio\studio-identity.json` contains `seedHex`. Never print that file. Never `cat` it.

## Test profile (required) and production profile (forbidden)

Test profile for this smoke: the local smoke profile documented in `packages/daemon/README.md` ("Smoke test" plus the configuration table).

- `POSTGRES_URL` unset and `POSTGRES_URL_FILE` unset. Neon sync stays off (`packages/daemon/src/neon.ts`).
- No production database drop-in. Do not install `packages/daemon/systemd/postgres-url-file.conf.example`. If that drop-in (or any other `ExecStartPre` that reads a production database URL from the vault) is already installed, this is a production profile. Stop. Do not start, restart, or reload the unit.
- `session.register` and `file.write` are Free tier (`docs/API_REFERENCE.md`). This smoke does not need a license JWT. Do not install `packages/daemon/systemd/license-file.conf.example` for this run. That example's `ExecStartPre` reads a vault secret.
- `Environment=NODE_ENV=production` in `packages/daemon/systemd/revdev-daemon.service` is Node's runtime mode. It is not a database profile and it is not permission to use production.

`daemon_setup` runs `systemctl --user enable --now revdev-daemon`, which starts the unit. `packages/daemon/systemd/install.sh` does the same. Do not run `daemon_setup`, do not run `install.sh`, and do not run `pnpm --filter @revdev/daemon setup:systemd` as part of this smoke. Those entry points start the daemon before the environment check below.

## Before any start

Run this in a WSL shell. It only prints unit configuration. It does not start the daemon.

```bash
systemctl --user cat revdev-daemon
systemctl --user is-active revdev-daemon || true
```

Expected output:

- The merged unit text, including drop-ins under `~/.config/systemd/user/revdev-daemon.service.d/` if any exist.
- `is-active` prints `inactive` (exit status may be non-zero; that is normal when the unit is stopped). `unknown` is also acceptable when the unit file is not installed yet. Come back to this check after step 2 if the unit was not installed yet.

Pass: the owner reads the merged unit and confirms all of the following, then writes `environment confirmed: test profile, production database drop-in absent` in the results notes before any later start command.

- No `ExecStartPre` line reads a production database URL from the vault. The production example is `packages/daemon/systemd/postgres-url-file.conf.example`.
- No `Environment=POSTGRES_URL=...` and no `Environment=POSTGRES_URL_FILE=...`.
- No license `ExecStartPre` is required for this smoke.

Fail: any production database `ExecStartPre` is present, or `is-active` prints `active` or `activating`. Do not continue. Do not stop or restart a unit that is already active; it may be a production daemon. Mark the smoke fail and leave the unit as it was.

Rollback: none. This step does not change the system. If a previous attempt copied the production example drop-in into place during this same smoke, move that drop-in file aside (do not delete unrelated drop-ins) and run `systemctl --user daemon-reload` only. Do not `start` or `restart`.

## Preconditions (do not start the unit)

1. systemd inside the distro is up. `daemon_setup` calls `wsl::ensure_systemd` first and stops when it is not.

```bash
systemctl is-system-running || true
```

Expected output: `running` or `degraded`.

Pass: stdout is exactly `running` or exactly `degraded`.

Fail: `offline`, empty output, or a command-not-found error. The product path then runs this best-effort write and returns an error telling the operator to shut WSL down from Windows:

```bash
grep -qs '^systemd=true' /etc/wsl.conf || printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf >/dev/null
```

From a Windows terminal after that write:

```bat
wsl.exe --shutdown
```

Reopen the distro and run `systemctl is-system-running` again. Expected after the reopen: `running` or `degraded`.

Rollback for the `wsl.conf` append: only if this smoke added the `[boot]` / `systemd=true` lines and they were not already there, edit `/etc/wsl.conf` and remove those added lines. Do not delete the rest of the file. A `wsl.exe --shutdown` is still required before a corrected `wsl.conf` is picked up. If `systemd=true` was already present before this smoke, leave it.

2. Build the daemon bundle so the unit can point at it. This does not start the daemon.

```bash
pnpm --filter @revdev/protocol build
pnpm --filter @revdev/daemon build
test -f packages/daemon/dist/cli.js
test -f packages/daemon/dist/agent-identity-crypto.js
```

Expected output: both `test` commands exit 0. Build logs from `pnpm` are fine.

Pass: both files exist.

Fail: either `test` exits non-zero.

Rollback: `pnpm --filter @revdev/daemon clean` removes `packages/daemon/dist`. Leave `packages/protocol/dist` in place if other local work uses it.

3. Install the systemd user unit without enabling or starting it. These are the path-substitution lines from `packages/daemon/systemd/install.sh` up to, and not including, `systemctl --user daemon-reload` and `systemctl --user enable --now revdev-daemon`.

```bash
set -euo pipefail
REPO_ROOT=$(pwd)
DAEMON_PATH="$REPO_ROOT/packages/daemon/dist/cli.js"
NODE_PATH=$(command -v node)
UNIT_DIR="${HOME}/.config/systemd/user"
TEMPLATE="$REPO_ROOT/packages/daemon/systemd/revdev-daemon.service"
test -f "$DAEMON_PATH"
test -x "$NODE_PATH"
mkdir -p "$UNIT_DIR"
ESCAPED_NODE=$(printf '%s\n' "$NODE_PATH" | sed 's/[&"]/\\&/g')
ESCAPED_PATH=$(printf '%s\n' "$DAEMON_PATH" | sed 's/[&"]/\\&/g')
sed "s|/usr/bin/env node %h/revealfleet/revdev/packages/daemon/dist/cli.js|\"$ESCAPED_NODE\" \"$ESCAPED_PATH\"|" \
  "$TEMPLATE" > "$UNIT_DIR/revdev-daemon.service"
echo "unit-written"
```

Expected output: a final line `unit-written`, exit 0. The file `~/.config/systemd/user/revdev-daemon.service` exists. This command does not call `systemctl`.

Pass: `grep -q ExecStart "${HOME}/.config/systemd/user/revdev-daemon.service"` exits 0, and the `ExecStart` line quotes the node binary and `packages/daemon/dist/cli.js`.

Fail: `node` missing, `dist/cli.js` missing, or `sed` produced a unit that still contains the template token `%h/revealfleet/revdev`.

Rollback:

```bash
rm -f "${HOME}/.config/systemd/user/revdev-daemon.service"
```

Do not remove other files in that directory. Do not `daemon-reload` until step 2, and do not `start`.

4. Locate the existing Studio identity file from Windows PowerShell. This prints a path only.

```powershell
$identity = Join-Path $env:LOCALAPPDATA "revealui-studio\studio-identity.json"
wsl.exe -d Ubuntu -e wslpath -a $identity
```

Expected output: one WSL path ending in `revealui-studio/studio-identity.json`, exit 0.

Pass, inside WSL:

```bash
export STUDIO_IDENTITY_PATH="<the wslpath line>"
test -f "$STUDIO_IDENTITY_PATH"
```

Fail: `wslpath` errors, or `test -f` fails. The file is created by `load_or_create_identity` when Studio runs `daemon_setup`, and that command starts the daemon. If the file is missing, stop this smoke. Do not launch Studio setup to mint an identity.

Rollback: none. Do not delete an existing identity file. It is the install's signing seed.

## Step 1. Relay staging

Build the Linux ELF inside WSL, then copy it the way `daemon_setup` does. Do not build this binary with a Windows msvc target. A PE file will not run in WSL.

Build (from `apps/studio/src-tauri/wsl/README.md`), repo root:

```bash
cargo build --release --manifest-path apps/studio/relay/Cargo.toml
```

Expected output: cargo finishes with an `revdev-relay` release binary at `apps/studio/relay/target/release/revdev-relay`. Exit 0.

Stage. `daemon_setup` runs this fragment after `wslpath -a` on the Windows resource directory (`REVDEV_SETUP_PAYLOAD`, or the Studio resource dir plus `wsl`). For this smoke the payload directory is the release directory just built. Set `WSL_PAYLOAD` to that directory (a WSL path, not a `C:\` path).

```bash
set -euo pipefail
WSL_PAYLOAD="$(pwd)/apps/studio/relay/target/release"
test -f "${WSL_PAYLOAD}/revdev-relay"
mkdir -p "${HOME}/.local/bin"
cp "${WSL_PAYLOAD}/revdev-relay" "${HOME}/.local/bin/revdev-relay"
chmod +x "${HOME}/.local/bin/revdev-relay"
file "${HOME}/.local/bin/revdev-relay"
```

The product command Studio runs from Windows, for the same copy, is:

```bat
wsl.exe -d Ubuntu -e wslpath -a <WINDOWS_PAYLOAD_DIR>
wsl.exe -d Ubuntu -e bash -lc "set -e; mkdir -p \"$HOME/.local/bin\"; cp '<WSL_PAYLOAD>/revdev-relay' \"$HOME/.local/bin/revdev-relay\"; chmod +x \"$HOME/.local/bin/revdev-relay\""
```

`<WINDOWS_PAYLOAD_DIR>` is the directory that contains `revdev-relay` on the Windows filesystem. `wslpath` stdout is the `<WSL_PAYLOAD>` substituted into the second command. This smoke uses the in-WSL `cp` above so the ELF never has to cross from a Windows build.

Expected output of `file`: a line that includes `ELF` and `x86-64`. Exit 0.

Pass:

```bash
test -x "${HOME}/.local/bin/revdev-relay"
file "${HOME}/.local/bin/revdev-relay" | grep -q ELF
```

Both exit 0, and the `file` line does not describe a Windows PE image.

Fail: cargo failed, `test -x` failed, or `file` does not report an ELF.

Rollback:

```bash
rm -f "${HOME}/.local/bin/revdev-relay"
```

## Step 2. systemctl --user enable

`daemon_setup` runs `systemctl --user daemon-reload` and then `systemctl --user enable --now revdev-daemon` in one script. `--now` starts the unit and runs `ExecStartPre`. This step enables only. Do not pass `--now`. Do not `start`.

In WSL:

```bash
systemctl --user daemon-reload
systemctl --user enable revdev-daemon
systemctl --user is-enabled revdev-daemon
systemctl --user is-active revdev-daemon || true
```

The same argv Studio uses, without `--now`:

```bat
wsl.exe -d Ubuntu -e systemctl --user daemon-reload
wsl.exe -d Ubuntu -e systemctl --user enable revdev-daemon
```

Expected output:

- `daemon-reload` exits 0 with no unit error on stderr.
- `enable` exits 0. When the symlink is new, stdout includes `Created symlink` and `default.target.wants/revdev-daemon.service`. When the unit was already enabled, stdout may be empty and the exit status is still 0.
- `is-enabled` prints `enabled`.
- `is-active` prints `inactive`.

Pass: `is-enabled` is `enabled` and `is-active` is `inactive`.

Fail: `enable` exits non-zero, `is-enabled` is not `enabled`, or `is-active` is `active`, `activating`, or `failed`. `active` means something started the unit. Stop following this runbook and apply the rollback only if this smoke is what started it.

Rollback, only if this step created the enablement and the unit is not a pre-existing active daemon:

```bash
systemctl --user disable revdev-daemon
```

Expected: exit 0, and `systemctl --user is-enabled revdev-daemon` prints `disabled` (the non-zero exit from `is-enabled` on a disabled unit is normal). If `is-active` became `active` because `--now` was added by mistake, also run `systemctl --user stop revdev-daemon` before `disable`. If the unit was already `active` before this smoke, do not stop it.

## Step 3. Trust anchor via sudo tee

`build_trust_anchor_provision_script` writes one line, `agentId:fingerprint`, and overwrites the file. It does not append. Grammar from `validate_anchor_components`: `agentId` is non-empty ASCII letters, digits, `.`, `_`, or `-`, and contains no `:`. The fingerprint is non-empty ASCII letters and digits (base58). Do not invent a fingerprint and do not paste a real one into this doc.

Product command (placeholders only):

```bash
set -e
sudo mkdir -p /etc/revdev
printf '%s\n' '<AGENT_ID>:<FINGERPRINT>' | sudo tee /etc/revdev/trusted-client-fingerprint >/dev/null
sudo chmod 0644 /etc/revdev/trusted-client-fingerprint
```

Run this form instead. It is the same `sudo tee` write. The line is produced from the identity file and is not printed. `STUDIO_IDENTITY_PATH` was set in the preconditions. Run from the repo root so the script can load `packages/daemon/dist/agent-identity-crypto.js`.

```bash
set -euo pipefail
test -n "${STUDIO_IDENTITY_PATH}"
test -f "${STUDIO_IDENTITY_PATH}"
test -f packages/daemon/dist/agent-identity-crypto.js
cat > /tmp/revdev-smoke-anchor.mjs <<'EOF'
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = process.env.REPO_ROOT;
const mod = await import(pathToFileURL(`${root}/packages/daemon/dist/agent-identity-crypto.js`).href);
const stored = JSON.parse(readFileSync(process.env.STUDIO_IDENTITY_PATH, 'utf8'));
const agentId = String(stored.agentId ?? '');
const seedHex = String(stored.seedHex ?? '').trim();
if (!/^[A-Za-z0-9._-]+$/.test(agentId)) {
  console.error('FAIL agentId rejected');
  process.exit(1);
}
if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
  console.error('FAIL signing seed length');
  process.exit(1);
}
const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const pkcs8 = Buffer.concat([prefix, Buffer.from(seedHex, 'hex')]);
const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey);
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const fingerprint = mod.computeFingerprint(mod.spkiPemToRaw(String(pem)));
if (!/^[A-Za-z0-9]+$/.test(fingerprint)) {
  console.error('FAIL fingerprint rejected');
  process.exit(1);
}
process.stdout.write(`${agentId}:${fingerprint}\n`);
console.error('PASS anchor-line');
EOF
export REPO_ROOT="$(pwd)"
sudo mkdir -p /etc/revdev
node /tmp/revdev-smoke-anchor.mjs | sudo tee /etc/revdev/trusted-client-fingerprint >/dev/null
sudo chmod 0644 /etc/revdev/trusted-client-fingerprint
rm -f /tmp/revdev-smoke-anchor.mjs
```

`sudo` may prompt for a password. That prompt is expected.

Expected output: stderr line `PASS anchor-line`. stdout is empty because `tee` is redirected to `/dev/null`. Exit 0.

Pass (does not print the anchor line):

```bash
sudo python3 - <<'PY'
import os, re, stat
p = "/etc/revdev/trusted-client-fingerprint"
st = os.stat(p)
ok_owner = st.st_uid == 0 and st.st_gid == 0
ok_mode = stat.S_IMODE(st.st_mode) == 0o644
text = open(p, "r", encoding="utf-8").read()
lines = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
ok_line = False
if len(lines) == 1 and lines[0].count(":") == 1:
    agent, fp = lines[0].split(":", 1)
    ok_line = re.fullmatch(r"[A-Za-z0-9._-]+", agent) is not None and re.fullmatch(r"[A-Za-z0-9]+", fp) is not None
if ok_owner and ok_mode and ok_line and text.endswith("\n"):
    print("PASS trust-anchor")
else:
    print("FAIL trust-anchor")
    raise SystemExit(1)
PY
```

Expected: `PASS trust-anchor`.

Fail: node prints `FAIL ...`, `sudo` is refused, or the Python check prints `FAIL trust-anchor`. A refusal is the same condition `daemon_setup` reports: the relay can be installed while the anchor write still needs `sudo`.

Rollback:

```bash
sudo rm -f /etc/revdev/trusted-client-fingerprint
sudo rmdir /etc/revdev 2>/dev/null || true
rm -f /tmp/revdev-smoke-anchor.mjs
```

`rmdir` succeeds only when the directory is empty. Leave the directory in place if it holds anything else.

## Step 4. Owner start gate, then session.register

Re-read [Before any start](#before-any-start). The owner confirms the test profile in the results notes. Only then start. If confirmation fails, do not run the `start` command. Skip to the results table and mark steps 4 and 5 fail with note `not started: environment not confirmed`.

Start (owner, after confirmation):

```bash
systemctl --user start revdev-daemon
systemctl --user is-active revdev-daemon
```

Expected output: `start` exits 0. `is-active` prints `active`.

Reachability uses the staged relay. Studio's Windows child command (`relay_shell_command` in `win_process.rs`) is:

```text
/bin/bash -c "exec \"$HOME/.local/bin/revdev-relay\" \"$HOME/.local/share/revealui/harness.sock\""
```

In WSL the same binary and socket, one JSON line:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}' \
  | "${HOME}/.local/bin/revdev-relay" "${HOME}/.local/share/revealui/harness.sock"
```

Expected output: one JSON line with `"result"` and `"pong":true`. Exit 0.

Pass: `is-active` is `active` and the ping line contains `"pong":true`.

Fail: `start` exits non-zero, `is-active` is not `active`, or the relay prints `revdev-relay: connect` on stderr. Do not paste `journalctl` into the notes. If you open the journal, look only for whether `ExecStartPre` failed, and if any database URL is visible, stop reading and do not copy it.

```bash
journalctl --user -u revdev-daemon -n 20 --no-pager
```

Rollback of a start performed in this step:

```bash
systemctl --user stop revdev-daemon
systemctl --user is-active revdev-daemon || true
```

Expected: `inactive`. Do not run `stop` if this smoke was not what started the unit.

### session.register

`session.register` is unsigned (`harness.rs` treats it as exempt). Params match Studio: `agentId`, `agentName` `studio-ui`, `workDir`, `backend` `studio`, `publicKeyPem`. `workDir` here is the scratch repo from step 5's directory, created first so the session row does not store a home path. This does not call `file.write` yet.

```bash
set -euo pipefail
export SMOKE_REPO="${HOME}/revdev-daemon-setup-smoke-repo"
if [ -e "$SMOKE_REPO" ]; then
  echo "FAIL scratch repo already exists" >&2
  exit 1
fi
mkdir -p "$SMOKE_REPO"
git init -q -b main "$SMOKE_REPO"
export REPO_ROOT="$(pwd)"
cat > /tmp/revdev-smoke-register.mjs <<'EOF'
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const root = process.env.REPO_ROOT;
const home = process.env.HOME;
const mod = await import(pathToFileURL(`${root}/packages/daemon/dist/agent-identity-crypto.js`).href);
const stored = JSON.parse(readFileSync(process.env.STUDIO_IDENTITY_PATH, 'utf8'));
const agentId = String(stored.agentId ?? '');
const seedHex = String(stored.seedHex ?? '').trim();
const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const pkcs8 = Buffer.concat([prefix, Buffer.from(seedHex, 'hex')]);
const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey);
const publicKeyPem = String(publicKey.export({ type: 'spki', format: 'pem' }));
const fingerprint = mod.computeFingerprint(mod.spkiPemToRaw(publicKeyPem));
const did = `did:revealfleet:${agentId}:${fingerprint}`;

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const child = spawn(`${home}/.local/bin/revdev-relay`, [`${home}/.local/share/revealui/harness.sock`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    const rl = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timeout'));
    }, 8000);
    rl.once('line', (line) => {
      clearTimeout(timer);
      child.kill();
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(e);
      }
    });
    child.on('exit', (code) => {
      if (code && code !== 0 && err.includes('revdev-relay: connect')) {
        clearTimeout(timer);
        reject(new Error('relay-connect'));
      }
    });
    const frame = { jsonrpc: '2.0', id: 1, method, params };
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  });
}

const params = {
  agentId,
  agentName: 'studio-ui',
  workDir: process.env.SMOKE_REPO,
  backend: 'studio',
  publicKeyPem,
};
const res = await rpc('session.register', params);
if (res.error) {
  console.error(`FAIL session.register ${res.error.code}`);
  process.exit(1);
}
const result = res.result ?? {};
if (result.sessionId !== agentId || result.did !== did || result.publicKeyPem !== publicKeyPem) {
  console.error('FAIL session.register mismatch');
  process.exit(1);
}
console.log('PASS session.register');
EOF
node /tmp/revdev-smoke-register.mjs
rm -f /tmp/revdev-smoke-register.mjs
```

Expected output: `PASS session.register`. Exit 0. The command does not print `did`, `publicKeyPem`, or the fingerprint.

Pass: stdout is exactly `PASS session.register`.

Fail: `FAIL session.register -32004` means the anchor does not contain this install's `agentId:fingerprint` pair (`UntrustedClientKeyError`). `FAIL session.register mismatch` means the daemon enrolled a different key. `relay-connect` means the socket is down. Any other `FAIL session.register <code>` is a fail. Do not re-run with a production profile to "fix" it.

Rollback:

```bash
rm -rf "${HOME}/revdev-daemon-setup-smoke-repo"
rm -f /tmp/revdev-smoke-register.mjs
systemctl --user stop revdev-daemon
```

Run `stop` only if this smoke started the unit. The registered session row lives in the daemon data dir (`~/.local/share/revealui`). Stopping the daemon does not delete that directory. Leave the data dir in place unless the owner intends to drop a scratch database created only for this smoke; if so, stop the daemon first, then remove only that scratch data dir, and only after confirming it is not a database the owner needs. Do not delete `~/.local/share/revealui` when it already existed before this smoke.

## Step 5. Signed file.write round trip

`file.write` requires a signature and a `project.open` on a git repo (`filegit-signed.test.ts`). `project.open` is signature-required. Studio's `rpc_call` adds `actorAgentId` and signs the params it actually sends (`signing.rs`). This step does the same. The scratch repo from step 4 must still exist and must sit under the WSL home, not under `/mnt/c` (that mount is never-bound).

```bash
set -euo pipefail
export SMOKE_REPO="${SMOKE_REPO:-${HOME}/revdev-daemon-setup-smoke-repo}"
test -d "${SMOKE_REPO}/.git"
export REPO_ROOT="$(pwd)"
cat > /tmp/revdev-smoke-write.mjs <<'EOF'
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const root = process.env.REPO_ROOT;
const home = process.env.HOME;
const mod = await import(pathToFileURL(`${root}/packages/daemon/dist/agent-identity-crypto.js`).href);
const stored = JSON.parse(readFileSync(process.env.STUDIO_IDENTITY_PATH, 'utf8'));
const agentId = String(stored.agentId ?? '');
const seedHex = String(stored.seedHex ?? '').trim();
const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const pkcs8 = Buffer.concat([prefix, Buffer.from(seedHex, 'hex')]);
const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
const privateKeyPem = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
const publicKey = createPublicKey(privateKey);
const publicKeyPem = String(publicKey.export({ type: 'spki', format: 'pem' }));
const fingerprint = mod.computeFingerprint(mod.spkiPemToRaw(publicKeyPem));
const did = `did:revealfleet:${agentId}:${fingerprint}`;

function rpc(method, params, signature) {
  return new Promise((resolve, reject) => {
    const child = spawn(`${home}/.local/bin/revdev-relay`, [`${home}/.local/share/revealui/harness.sock`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timeout'));
    }, 8000);
    rl.once('line', (line) => {
      clearTimeout(timer);
      child.kill();
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(e);
      }
    });
    const frame = { jsonrpc: '2.0', id: 1, method, params };
    if (signature) frame['x-revdev-signature'] = signature;
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  });
}

function sign(method, params) {
  const payload = {
    did,
    kid: fingerprint,
    nonce: mod.generateNonce(),
    ts: Math.floor(Date.now() / 1000),
    method,
    paramsHash: mod.hashParams(method, params),
  };
  return mod.serializeEnvelope(mod.signEnvelope(payload, privateKeyPem));
}

const repoPath = process.env.SMOKE_REPO;
const content = 'wsl-daemon-setup-smoke';

const openParams = { repoPath, actorAgentId: agentId };
const open = await rpc('project.open', openParams, sign('project.open', openParams));
if (open.error || open.result?.success !== true) {
  console.error(`FAIL project.open ${open.error?.code ?? 'no-success'}`);
  process.exit(1);
}

const writeParams = { repoPath, filePath: 'note.txt', content, actorAgentId: agentId };
const written = await rpc('file.write', writeParams, sign('file.write', writeParams));
if (written.error || written.result?.success !== true) {
  console.error(`FAIL file.write ${written.error?.code ?? 'no-success'}`);
  process.exit(1);
}

const readParams = { repoPath, filePath: 'note.txt', actorAgentId: agentId };
const read = await rpc('file.read', readParams, sign('file.read', readParams));
if (read.error || read.result?.content !== content) {
  console.error(`FAIL file.read ${read.error?.code ?? 'mismatch'}`);
  process.exit(1);
}

const onDisk = readFileSync(`${repoPath}/note.txt`, 'utf8');
if (onDisk !== content) {
  console.error('FAIL ext4 mismatch');
  process.exit(1);
}
console.log('PASS file.write');
console.log('PASS file.read');
EOF
node /tmp/revdev-smoke-write.mjs
rm -f /tmp/revdev-smoke-write.mjs
```

Expected output:

```text
PASS file.write
PASS file.read
```

Exit 0. An unsigned `file.write` would fail with `-32003`. A repo with a formatter config can fail with `-32007`; this scratch repo has neither `biome.json` nor a Rust file, so the body `wsl-daemon-setup-smoke` is accepted as plain text. `note.txt` on ext4 contains that same string.

Pass: both PASS lines, and `test "$(cat "${SMOKE_REPO}/note.txt")" = "wsl-daemon-setup-smoke"`.

Fail: any `FAIL project.open`, `FAIL file.write`, `FAIL file.read`, or `FAIL ext4 mismatch` line. `-32003` means the signature did not verify. `-32004` on a follow-up call means the anchor does not match. Do not print the signature or the private key while debugging.

Rollback:

```bash
rm -rf "${HOME}/revdev-daemon-setup-smoke-repo"
rm -f /tmp/revdev-smoke-write.mjs
systemctl --user stop revdev-daemon
```

Again, `stop` only if this smoke started the unit. After a successful smoke the owner may also `systemctl --user disable revdev-daemon` if enablement was only for this run. Do not disable a unit the owner already relied on before the smoke.

## Results table

Copy this table into the run notes. One row per attempt. Pass/fail values are the words `pass` or `fail`. Notes must not contain a fingerprint, seed, token, license, vault path value, or database URL.

| Date (UTC) | Build SHA | Step 1 relay | Step 2 enable | Step 3 anchor | Step 4 register | Step 5 file.write | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| YYYY-MM-DD | `<full git rev-parse HEAD>` | pass/fail | pass/fail | pass/fail | pass/fail | pass/fail | environment confirmed or why it was not |

Build SHA is the checkout the owner built and smoked (`git rev-parse HEAD` inside the WSL repo). Date is the day the owner ran the smoke, UTC.

The Windows `cargo check` job in `.github/workflows/studio-windows-cargo-check.yml` only type-checks `apps/studio/src-tauri` for `x86_64-pc-windows-msvc`. It does not replace this smoke.
