# Changelog

All notable changes to RevealUI Studio are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dates are ISO 8601 (UTC).

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
