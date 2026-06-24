# ADR: RevDev as a Zero-9P WSL-Native Dev Surface

- **Status:** Proposed
- **Date:** 2026-06-23
- **Scope:** RevDev Studio (Tauri) + RevDev daemon
- **Summary:** The daemon-in-WSL becomes the single owner of all ext4 file/git/agent I/O. Studio becomes a pure signed-RPC client over the daemon's `AF_UNIX` socket, reached from Windows through a `wsl.exe`-launched stdio relay. No Windows process ever performs file or git I/O on a project path.

## Context

RevFleet code lives on the WSL2 ext4 filesystem. RevDev Studio is a Windows-native Tauri app. When Studio performs file or git I/O on a project path, it reaches ext4 through the Windows `\\wsl$` / `\\wsl.localhost` redirector, served by the Plan 9 (9P) protocol server inside the WSL VM.

That crossing is unsafe, and the unsafety is structural, not a bug we can tune away:

- Host writes are durable, but host **reads can return stale content** under a cache-timing window, so a landed write can read back as a silent no-op.
- Host git over the redirector reports **phantom modified files** from incoherent stat / ownership / mode metadata (the same file is owned differently as seen from WSL vs. from the host).
- There is **no `\\wsl$`-side coherency knob.** virtiofs accelerates only the opposite (`/mnt/c`) direction and introduces its own ownership incoherence. Microsoft officially recommends against cross-OS file work; Anthropic officially recommends running the agent inside WSL, which is also the only Windows surface with the OS-enforced sandbox.

Today Studio crosses this boundary for **every** project file/git operation (verified by source read):

- `commands/git.rs`: `expand_tilde` (`:65-72`) resolves `~` via `dirs::home_dir()`, which on Windows is the Windows profile, not the WSL home; `git_read_file` (`std::fs::read_to_string`, `:432`); `git_write_file` (`std::fs::write`, `:513`); `git_diff_content` (`std::fs::read_to_string`, `:469`, plus the `git2` blob helpers `:474-488` / `:490-502`); every `git2::Repository::open` command — `git_status`, `git_diff_file`, `git_stage_file` (its own `Repository::open` at `:220`), `git_unstage_file`, `git_discard_file`, `git_list_branches`, `git_create_branch`, `git_switch_branch`, `git_delete_branch`, `git_log`, `git_commit` (the `open_repo` helper is at `:76`; commands span `:84-545`); and `git_push` / `git_pull`, which spawn the git binary (`:357` / `:380`).
- `commands/agent.rs`: `agent_read_workboard` reads via `std::fs` (`:4-15`).

`git2` is the **sole consumer** of the crate in `src-tauri` (verified: 8 occurrences, only in `commands/git.rs`).

Studio already does the right thing for system-level work: the terminal/PTY defaults to `wsl.exe` (`local_shell.rs:51-59`), and git config / app start-stop / systemd checks delegate via a `wsl_exec` helper (`platform/windows.rs:17-33`). The **daemon** (`packages/daemon`, Node.js) already runs as a Linux process inside WSL and exposes JSON-RPC over an `AF_UNIX` socket — sessions, mail, tasks, file reservations, memory, and git worktree/merge operations (the latter shelling the git binary natively via `vcs.ts` `runGit`/`runChild` with timeout + abort). What it lacks: project file read/write and git status/diff/commit **content** methods. And its Studio-facing IPC (`harness.rs`) and lifecycle (`daemon_ctl.rs`) are `#[cfg(unix)]`-only, so Windows Studio cannot reach it — `harness.rs:212-219` returns "not supported on this platform," which is why Studio falls back to the unsafe direct-I/O path above.

## Decision

Make the **RevDev daemon, running inside WSL, the single owner of all ext4 file/git/agent I/O.** Studio becomes a pure RPC client that performs **zero** file/git I/O on project paths. Concretely:

1. **Add daemon-side `file.*` and `git.*` RPC methods** that do the I/O as a Linux process on ext4 (Node `fs/promises` for files; reuse the existing `runGit`/`runChild` git spawning for git).
2. **Delete Studio's Windows file/git path:** remove `expand_tilde` and `open_repo`; rewrite every `git_*` command and `agent_read_workboard` as thin async wrappers over the new RPCs; remove the `git2` crate from `Cargo.toml` (sole consumer, no fallback).
3. **Studio passes paths verbatim;** the daemon expands `~` against its own (WSL) `$HOME`. Studio never resolves project paths.
4. **Transport:** keep the daemon's `AF_UNIX` socket; Windows Studio reaches it through a `wsl.exe`-launched **stdio relay** speaking the same newline-delimited JSON-RPC. Replace the `#[cfg(not(unix))]` stub; keep the native `UnixStream` path for Linux/macOS.
5. **Lifecycle:** a `systemd --user` unit owns the daemon inside WSL; Studio drives it on Windows via `wsl.exe ... systemctl --user`. No Windows process reads the ext4 PID file.

This also revives agent-coordination and the merge pipeline on Windows as a side effect (currently dead via the `#[cfg(unix)]` IPC stub).

## Transport and security

**Transport choice: `AF_UNIX` over a `wsl.exe` stdio relay.** Studio spawns a long-lived child `wsl.exe -d <distro> -e <relay> <socket-path>`, where `<relay>` is a small bundled Rust `AF_UNIX`↔stdio relay installed to the WSL `~/.local/bin`, and speaks JSON-RPC over the child's stdin/stdout. The daemon only ever sees an ordinary Unix-socket connection, so the wire protocol, framing, and handlers are byte-identical across platforms.

Rejected transports: a `mirrored`-localhost TCP port would be reachable by **any** host process (mirrored networking shares loopback), turning a filesystem-permission + signature boundary into a token-only network boundary — strictly weaker. Named Pipes would need a bespoke Windows transport plus a long-running WSL pipe↔socket bridge for no security gain. The unbuilt HTTP gateway is unnecessary once auth rides the existing signature scheme.

**Three layered, code-level barriers** (the `0600` socket alone is *not* sufficient — any host process can run `wsl.exe` as the WSL user and reach the socket, so file permissions stop a hostile *non-owner WSL* process, not a hostile *host* process):

1. **Socket + parent-dir mode.** Socket is `chmod 0600`; the socket parent directory is created with explicit `mode 0o700` (today the `mkdir` passes no mode and inherits the umask — fix it).
2. **Required Ed25519 signature** for every mutating method **and every content-returning read** (`file.read`, `file.stat`, `git.diffContent`, `git.readBlob*`). Studio holds a per-install private key in the **Windows-local vault (never on ext4)**; the daemon holds only the public key. This is the real barrier against a hostile host process: it cannot read project files (or `~/.ssh`, `~/.age-identity`) without the key. Payload-free coordination reads (`ping`, `session.list`, `git.status` name lists) stay signature-optional behind the `0600` boundary.
3. **Repo-root allowlist + traversal check** in every `file.*` / `git.*` handler: reject any `repoPath` not in the daemon's registered-project-roots set (populated by a `project.open` RPC), and after `realpath` reject any target that is not a descendant of the resolved repo root. Defends even a key-holding caller against path traversal and secret exfiltration.

The signature today is **warn-only** — `verifyOrWarn` returns `void` and "never rejects the request" (`server.ts:1368`, signature at `:328`). Enforcing it is a dispatch-loop change: `verifyOrWarn` returns a verification-result enum; at the dispatch call site (`server.ts:1370`), if the method is in a named `MUTATING_OR_CONTENT_METHODS` set and the result is not `verified`, write a new JSON-RPC error (`-32003` "signature required") and `continue`, mirroring the license-guard block at `:1342-1345`.

## Tier model (decided)

The license guard is **binary** — `guardRpcMethod` (`guard.ts:154-175`) admits a method only if it is in `EXEMPT_METHODS` (`license.ts:63-73`: today `ping` + `session.*`) **or** a valid Pro+ license is present; everything else returns `-32001`. There is no "free read tier."

**Decision: all single-repo file/git I/O is FREE.** Add the enumerated single-repo methods to `EXEMPT_METHODS` — `file.read`, `file.write`, `file.delete`, `file.stat`, `project.open`, and every `git.*` (`status`, `diffFile`, `diffContent`, `stageFile`, `unstageFile`, `discardFile`, `listBranches`, `createBranch`, `switchBranch`, `deleteBranch`, `log`, `commit`, `push`, `pull`, `readBlobAtHead`, `readBlobAtIndex`). No wildcard. Only **multi-agent coordination** stays Pro: `agent.*`, `merge.*`, `mail.*`, `tasks.*`, `files.*` reservations, `memory.*`, `inference.*`. Rationale: RevDev is meant to be a usable free daily-driver editor and a dogfood surface; gating basic editing/committing of your own repo behind a paid tier makes it unusable and contradicts the dogfood goal. A CI test asserts each newly-exempt method returns success (not `-32001`) on a free license, and that the Pro methods still return `-32001`, locking the boundary.

## Implementation plan (execution order; all phases run from a WSL-native session)

**Pre-flight gates (accepted):** bundle a ~30-line Rust `AF_UNIX`↔stdio relay (zero external dependency, fully owned) rather than depend on `socat`; require `systemd=true` in the distro's `/etc/wsl.conf` as the lifecycle owner (accepting a one-time `wsl --shutdown` if not already enabled).

**P0 — Daemon-side file/git RPC surface + tier exemptions + signature enforcement.**
- Add `file.read` / `file.write` / `file.delete` / `file.stat` and a `project.open` that registers a project root; implement with `node:fs/promises`, expanding `~` against the daemon's `$HOME`.
- Add `git.*` handlers mirroring the migrated command set, reusing `runGit`/`runChild` (`vcs.ts`) — shell the git binary natively in WSL; do not add a JS git binding.
- Enforce the repo-root allowlist + `realpath` descendant check in every handler.
- Tier: add the enumerated single-repo methods to `EXEMPT_METHODS` (`license.ts:63-73`); add the free/Pro CI tests.
- Signature: change `verifyOrWarn` (`server.ts:328`) to return a `VerificationResult` enum; add `MUTATING_OR_CONTENT_METHODS` and the `-32003` reject + `continue` at the dispatch site (`server.ts:1370`).
- Frame cap: `file.read` / `git.diffContent` / `git.readBlob*` measure byte length before serializing and return `{ tooLarge: true, bytes }` above a new `maxInlineReadBytes` (the inbound cap at `server.ts:1272` does not guard the response write at `:1414`).
- Socket dir mode: `mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })` (`server.ts:1139`).
- Anchors: `server.ts:328,1139,1272,1340-1390,1414`; `license.ts:63-73`; `guard.ts:154-175`; `vcs.ts`.

**P1 — Studio cross-platform IPC client (relay + signing).** [blocked on relay choice]
- Replace the `#[cfg(not(unix))]` stub (`harness.rs:212-219`) with a Windows path that spawns the relay via `wsl.exe` and speaks JSON-RPC over its stdio; keep the `UnixStream` path (`:127-210`) for native Unix; unify `rpc_call_raw` framing.
- Build/ship the bundled Rust relay; install to the WSL `~/.local/bin` on first run if absent.
- Studio-side Ed25519: generate a per-install keypair stored in the **Windows-local vault** (`commands/vault.rs`, never ext4); register the public key with the daemon at `session.register`; sign every `MUTATING_OR_CONTENT_METHODS` call.
- Relay-death resilience: add a Windows `is_transient_error` covering spawn failure / child-stdout EOF / broken pipe (the existing one is `#[cfg(unix)]` and matches Unix-socket strings only); respawn bounded by `MAX_RETRIES` and surface a typed "daemon unreachable" instead of hanging; health-ping before reuse.
- Anchors: `harness.rs:83-105,127-219`; `commands/vault.rs`.

**P2 — Delete Studio's Windows ext4 path.** [blocked on P0+P1]
- Rewrite `git_read_file` / `git_write_file` / `git_diff_content` and every `git2`/`Command("git")` command as async wrappers over the RPCs; delete `expand_tilde` + `open_repo`; rewrite `agent_read_workboard` to `file.read`; remove `git2` from `Cargo.toml`.
- Anchors: `commands/git.rs:65-545`; `commands/agent.rs:4-15`; `Cargo.toml`.

**P3 — Daemon lifecycle via systemd-user + `wsl.exe`; eliminate all Windows ext4 PID reads.** [blocked on systemd gate]
- Author a `systemd --user` unit (`Restart=on-failure`) as the single lifecycle source inside WSL.
- Rewrite `daemon_start` / `daemon_stop` / `daemon_restart` to run `wsl.exe ... systemctl --user ...`; native Unix keeps direct spawn/SIGTERM.
- Delete `read_pid` / `pid_file_path` / `is_pid_alive` from the Windows path; rewrite `daemon_status` (`daemon_ctl.rs:79-91`, currently an unconditional ext4 PID read) so Windows liveness = `systemctl --user is-active` and reachability = a `ping` RPC over the relay.
- Anchors: `daemon_ctl.rs:15-22,50-67,79-91`; `platform/windows.rs:17-33`.

**P4 — Install/build pipeline.** [blocked on both gates]
- WSL first-run setup: build/copy the daemon to the WSL `~/.local/bin`, install the relay, `systemctl --user enable --now`.
- Assert systemd is active (`systemctl is-system-running`); if not, write `systemd=true` to `/etc/wsl.conf` and **fail setup with an explicit actionable error** requiring a one-time `wsl --shutdown` (no silent no-op); `daemon_status` surfaces "systemd-user unavailable" distinctly from "stopped."
- Update the Studio release workflow to produce the Linux daemon + relay alongside the Windows bundle; the Windows installer stages them into WSL and ships **no** Windows daemon binary.
- Anchors: `daemon_ctl.rs:24-47`; Studio release workflow; `/etc/wsl.conf`.

**P5 — Regression fence + tests + this ADR.**
- CI deny-list gate that fails the build if `commands/git.rs` or `commands/agent.rs` reintroduce `std::fs::{read_to_string,write}`, `git2::Repository::open`, or `Command("git")` for project paths (enforced in CI, not by review convention).
- Integration tests: round-trip `file.write`→`file.read` via the relay with no stale read; signed-mutation accepted / unsigned rejected `-32003` / replayed-nonce rejected / read outside the registered root rejected; free-license call of each newly-exempt method returns success; `tooLarge` response path; daemon start/stop via `systemctl`-in-WSL and relay respawn-on-kill returning a typed unreachable after `MAX_RETRIES`.
- Commit this ADR. No host-absolute paths in any committed artifact.

## Risks and mitigations (every risk has a concrete fix; no soft mitigations)

- **`file.*` becomes an arbitrary-ext4 read/write + traversal primitive.** → Registered-project-roots allowlist + `realpath` descendant check in every handler; tests assert a `~/.ssh` read and a `../../` escape are both rejected.
- **Content reads were signature-optional, so a host process could exfiltrate files via the relay.** → Signatures required for all content-returning reads, not just mutations.
- **Studio's signing key on ext4 would itself cross 9P.** → Key lives in the Windows-local vault; the daemon holds only the public key.
- **Relay child dies mid-session and hangs Studio on a dead pipe.** → Windows `is_transient_error` + bounded respawn + typed "unreachable"; health-ping before reuse; test kills the relay and asserts recovery.
- **A Windows process still reads the ext4 PID file (`daemon_status`).** → Delete the Windows PID-file reads; liveness via `systemctl is-active` + `ping` RPC.
- **Large diff/blob exceeds the response frame cap.** → Measure bytes pre-serialize; return `{ tooLarge }`; editor falls back to a streamed/read-only view.
- **systemd-user not enabled, lifecycle silently dead.** → Setup asserts `systemctl is-system-running`, writes `systemd=true`, and fails loudly with the `wsl --shutdown` instruction.
- **A future change reintroduces a Windows `std::fs`/`git2` project path.** → CI deny-list gate fails the build.
- **`EXEMPT_METHODS` additions accidentally exempt a Pro method.** → Explicit enumerated list, no wildcard; CI test asserts the Pro methods still return `-32001` on free.

## Alternatives considered

- **Wrap Studio's git commands in `wsl.exe` per call (the lighter patch).** Rejected: insufficient. The `git2` metadata ops, `push`/`pull`, and the workboard read all cross 9P too; only moving the whole surface into the daemon eliminates the boundary, and per-call `wsl.exe` keeps two divergent I/O paths.
- **`mirrored`-localhost TCP transport.** Rejected: reachable by any host process; strictly weaker than `AF_UNIX` + signature.
- **HTTP gateway.** Rejected: unbuilt, and unnecessary for security once auth rides the existing Ed25519 scheme.
- **Named Pipes.** Rejected: bespoke Windows transport + a WSL pipe↔socket bridge, duplicating framing for no gain.
- **Wait for a vendor "connect to WSL" feature.** Rejected: not on any roadmap; this design depends on no unshipped feature.

## References

- Probe + verification of the 9P stale-read / phantom-git-metadata class (session 2026-06-23).
- Microsoft "Working across file systems" and "Do not change Linux files using Windows apps and tools."
- Anthropic Claude Code setup guidance (run inside WSL; WSL2 is the only sandbox-capable Windows surface).
- Source anchors: `commands/git.rs`, `commands/agent.rs`, `packages/daemon/src/{server.ts,guard.ts,license.ts,vcs.ts}`, `harness.rs`, `daemon_ctl.rs`, `platform/windows.rs`, `local_shell.rs`.
