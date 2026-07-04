# Changelog

All notable changes to RevealUI Studio are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Dates are ISO 8601 (UTC).

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
