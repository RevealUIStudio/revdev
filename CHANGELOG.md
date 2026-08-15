# Changelog

All notable changes to RevealUI Studio are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dates are ISO 8601 (UTC).

## [Unreleased]

## [0.2.6] — 2026-08-15

### Fixed

- **Windows release compile.** `SHChangeNotify` takes `i32`.
  `CommandExt::show_window` is still unstable on CI rustc, so leftover
  console children keep CREATE_NO_WINDOW only. Agent uses `WslLaunch`.
- **Quality lint.** Biome no longer treats ICO source SVGs as DOM.

[0.2.6]: https://github.com/RevealUIStudio/revdev/releases/tag/studio-v0.2.6

## [0.2.5] — 2026-08-15

### Fixed

- **Taskbar icon.** The running window sets the Circuit-R mark and asks
  Explorer to drop the cached Tauri cube. 16/24px icons use the untiled
  mark so the pin is not a smudge.
- **Agent flash after 0.2.4.** The relay starts with `WslLaunch` (no
  `wsl.exe` console). Parallel Agent RPCs no longer race past the
  spawn cooldown.

[0.2.5]: https://github.com/RevealUIStudio/revdev/releases/tag/studio-v0.2.5

## [0.2.4] — 2026-08-15

### Fixed

- **One Studio process.** A second launch focuses the existing window
  instead of opening another copy.
- **Agent terminal flash.** Windows reuses one hidden WSL relay and does
  not spawn `wsl.exe` again for 20s after a failed connect. Agent click
  no longer launches a stack of consoles.
- **Agent daemon-down copy.** One Setup line. The spawn panel and the
  offline chip do not repeat it.

[0.2.4]: https://github.com/RevealUIStudio/revdev/releases/tag/studio-v0.2.4

## [0.2.3] — 2026-08-14

### Fixed

- **App icon.** Taskbar, window, and tray use the RevealUI Circuit-R mark
  from the design system, not the default Tauri cube. Sidebar and the
  intent screen render `RevealUIMark` instead of a letter tile.
- **Setup Skip hover.** Ghost chrome keeps body ink on hover so Skip stays
  readable.
- **Agent errors.** Tauri `{ kind, message }` rejects show the real
  message, not `[object Object]`. A down WSL daemon is one Setup line.

[0.2.3]: https://github.com/RevealUIStudio/revdev/releases/tag/studio-v0.2.3

## [0.2.2] — 2026-08-14

### Fixed

- **Console flashes after close.** Window X quits the process instead of
  hiding to the tray. Windows `wsl.exe` / `cmd` / `pwsh` spawns use
  `CREATE_NO_WINDOW` so daemon polls do not flash a terminal.

[0.2.2]: https://github.com/RevealUIStudio/revdev/releases/tag/studio-v0.2.2

## [0.2.1] — 2026-08-14

### Added

- **Auto-update feed.** Studio bundles updater artifacts. New `studio-v*` tags
  publish `latest.json` to the rolling `studio-latest` GitHub release. The
  client tries `releases.revealui.com` first, then that GitHub feed.
- **Deploy-wizard Gmail probe (revdev#15).** Send-test uses the service account
  and domain-wide delegation, returns a Gmail message id, and rate-limits at
  5/min. Next stays disabled until the send succeeds.

### Fixed

- **Deploy wizard honesty.** Draft (including generated secrets) persists in
  local config (mode 0600). Sidebar cannot skip past the first incomplete
  step. Verify fails when email was not probed or the API project id is
  missing. Deploy poll can be cancelled. Config load failure shows Retry.
- **First-run and WSLg.** Local-first first-run and refuse-to-start when WSLg
  cannot present a window (revdev#405, #406), included in this desktop tag.

[0.2.1]: https://github.com/RevealUIStudio/revdev/releases/tag/studio-v0.2.1


### Added

- **GAP-269 spawned agent identity.** `agent.spawn` mints a distinct
  key-derived child principal (`key_origin=spawned`), returns one-shot
  `privateKeyPem` / DID, and records `parent_agent` + child `owner_agent` on
  the process row. Parent or child may drive stop/input/resize/output;
  siblings cannot. Migration 0011.
- **GAP-309 format enforcement on `file.write`.** When a registered root declares
  `biome.json` / `biome.jsonc` or `Cargo.toml`, unformatted content is
  **check-and-rejected** with JSON-RPC `-32007` (includes `data.fixCommand`)
  before any disk write. No rewrite of caller bytes; no hardcoded repo path
  allow-list. See `docs/decisions/2026-08-05-file-write-format-check-and-reject.md`.
- **GAP-294 §9 agent-scoped grants.** Operator-issued scope grants
  (`permission.grant` / `listGrants` / `revokeGrant`, migration 0009) cover
  sessions in `agent-scoped` mode: consequential by class or method; critical
  only by explicit method name. Unmatched calls still escalate to the pending
  approval queue. Bridge MCP tools + Studio signing parity included.
- **GAP-294 Phase 0 permission shadow gate.** Every RPC is classified
  (`routine` / `consequential` / `critical` per owner-countersigned map) and
  emits `permission.would_allow` / `permission.would_require_approval` events
  without blocking. Simulated mode via `REVDEV_PERMISSION_SHADOW_AS=manual|auto`
  (default manual).
- **GAP-294 Phase 1 manual/auto enforce (headless).** With
  `REVDEV_PERMISSION_MODE=manual|auto`, consequential/critical calls get
  reject-with-receipt (`-32004`, `pending_approvals` queue). `permission.pending`
  + signed `permission.decide` (no self-approval). Migration 0007. Default remains
  shadow until the operator sets the env.
- **GAP-294 skill-tool enforce.** `skills.invoke` inner tools use the same
  queue. `skills.tool.Read` / `Grep` / `Glob` are routine. `skills.tool.Bash`
  is critical (auto still requires approval). Install default stays shadow.

### Fixed

- **CLI / free-mode license help honesty.** Tier help is sourced from
  `LICENSE_TIER_HELP` (aligned with `EXEMPT_METHODS` + `METHOD_MIN_TIER`): free
  includes single-repo file/git + local inference run; Pro is multi-agent
  coordination; Max is memory.* + inference management. CLI version string
  matches package `0.2.0`.
- **Bridge worktree tools (revdev#182).** `worktree_create` / `worktree_remove`
  require `repoPath` and a signed client (`REVDEV_AGENT_DID` +
  `REVDEV_AGENT_PRIVATE_KEY_PEM`); fail with an actionable error when unsigned
  instead of a silent `-32003` / missing-param path.
- **agent.* load-order stubs.** Header and errors no longer claim spawn is
  desktop-only; production path is daemon PTY (`spawn.ts`) overwriting stubs.

### Changed

- **PLAN.md / SPEC.md truth-sweep (INIT-002 Phase 0).** W4 dogfood Phase 2 and
  W8–W13 remediation marked shipped where code already landed; SPEC method
  table matches the real registry (no phantom `harness.stats` / `events.tail`).

## [0.2.0] — 2026-07-17

### Added

- **Session-lifecycle advisory check surface.** `session.register` now runs a
  registry of best-effort, warn-only checks and returns their warnings in the
  response. A check that throws is logged and skipped, so a defect in one
  check can never fail registration.
- **Canonical doc-locations check.** A provider-agnostic check validates a
  project's doc directory layout (restricted directories, required index
  files per subdirectory) against a configurable rule set. It carries no
  project-specific paths and is a no-op until a project supplies rules.
- **Dup-work-claim check.** Warns when the same configured claim marker (for
  example "TASK-" or "GAP-") appears in two or more git worktrees of a
  project, flagging that two sessions may be building the same thing. The
  marker set is configurable and empty by default.
- **Native tool-guard for daemon request actions.** A pure, synchronous
  pattern guard, the daemon-native sibling of the Claude Code PreToolUse
  scanner, evaluates command/read/write/delete actions against a versioned
  pattern manifest and denies dangerous or credential-adjacent actions. Wired
  into `file.read`/`file.write`/`file.delete` and `agent.spawn`; an unloadable
  manifest refuses to start the daemon.
- **Browser-mode agent list/remove and Ollama model deletion.** `agent.list`,
  `agent.remove`, and `inference.delete` are now served by the daemon
  (signature-required, Pro tier), and Studio's browser mode adapts them to
  its existing types instead of rejecting them as desktop-only.
- **RPC registry contract test.** `RPC_METHODS` is now generated from the
  handler registry via `listRegisteredMethods()` and asserted equal to it in
  both directions, closing drift between the declared method list, the
  actual handlers, and Studio's `HARNESS_RPC_MAP`. Adds a `merge_update` MCP
  tool for the previously callerless `merge.update` handler.

### Fixed

- Studio's browser mode no longer calls daemon RPC methods the daemon does
  not register (`agent_list`/`agent_remove` and the `inference.ollama.*`/
  `inference.snap.*` namespaces). Unmapped commands now reject with a clear
  desktop-only error instead of a silent JSON-RPC `-32601`.
- CI: every `actions/checkout` step in `ci.yml` and `promotion-gate.yml` now
  sets `persist-credentials: false` so the `GITHUB_TOKEN` is never left on
  disk in the job workspace. `backflow-main-into-test.yml` now triggers on
  push to both `main` and `test`, runs in a concurrency group, and scopes
  secrets to the two backflow app secrets instead of inheriting all caller
  secrets.

## [0.1.1] — 2026-07-03

### Fixed

- Daemon license activation now works with only the license JWT: the vendor
  public key ships baked into the daemon as the default (override via
  REVDEV_LICENSE_PUBLIC_KEY unchanged). Previously a fresh install without the
  public-key env var fell back to the Free tier silently.

### Changed

- Test-suite hardening: resource-aware bounded concurrency and a de-brittled
  shutdown-drain hang guard.

## [0.1.0] — 2026-07-01

First public release of RevealUI Studio — a native desktop AI editor and
agent-coordination dashboard.

### Added

- Desktop Studio app (Tauri 2 + React 19): AI editor and agent-coordination
  dashboard.
- Bundled harness daemon coordinating agent sessions, terminals, and tools over
  a local JSON-RPC surface.
- Tiered daemon capabilities across the Free / Pro / Max plans.
- Session activity tracking (active / blocked / idle) so coordinating agents can
  tell a working session from one awaiting input.
- Signed auto-update channel for Linux and Windows builds.

### Known limitations

- macOS builds in this release are not yet Apple-notarized; macOS Gatekeeper may
  warn on first launch. Notarization is planned for a future release.
- Auto-update delivery (`releases.revealui.com`) is not yet wired for this first
  release; install from the release artifacts directly.

[0.1.0]: https://github.com/RevealUIStudio/revdev/releases/tag/studio-v0.1.0
