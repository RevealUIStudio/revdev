---
title: "Security Policy"
description: "We release patches for security vulnerabilities. Currently supported versions:"
visibility: public
status: verified
audience: user
---

# Security Policy

## Supported Versions

We release patches for security vulnerabilities. Currently supported versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | :white_check_mark: |

## Reporting a Vulnerability

We take the security of RevDev (Studio, Console, and the harness daemon) seriously. If you discover a security vulnerability, please follow these steps:

### Where to Report

**Please DO NOT report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to: **security@revealui.com**

### What to Include

Please include the following information in your report:

- Type of vulnerability
- Full paths of source file(s) related to the manifestation of the vulnerability
- Location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the vulnerability, including how an attacker might exploit it

### Response Timeline

- We will acknowledge your email within 48 hours
- We will send a more detailed response within 7 days indicating the next steps
- We will work on a fix and coordinate a release timeline with you
- We will notify you when the vulnerability has been fixed

### Disclosure Policy

- Once a fix is released, we will publicly disclose the vulnerability
- We appreciate allowing us time to remediate before public disclosure
- We will credit you for responsible disclosure (unless you prefer to remain anonymous)

### Safe Harbor

We support safe harbor for security researchers who:

- Make a good faith effort to avoid privacy violations, destruction of data, and interruption or degradation of our services
- Only interact with accounts you own or with explicit permission of the account holder
- Do not exploit a security issue you discover for any reason
- Report the vulnerability promptly
- Allow a reasonable time to fix the issue before public disclosure

## Security Best Practices

When using RevDev, we recommend:

1. **Keep secrets in a vault**: Studio talks to `revvault-core`. Do not commit keys, tokens, or license material, and do not treat environment variables as the source of truth.
2. **Keep dependencies updated**: Run `pnpm update` for the JS workspace and `cargo update` in `apps/studio/src-tauri` (and `go get -u` in `apps/console`) on a regular cadence.
3. **Prefer official binaries**: Install Studio and Console from GitHub Releases for this repository. Treat unsigned or ad-hoc local builds as development-preview.
4. **Sanitize untrusted terminal output**: Studio uses `@revealui/security` (`sanitizeTerminalLine`) on terminal lines. Do not bypass that path when adding UI that renders agent or PTY output.

## Questions

If you have questions about this policy, please contact us at security@revealui.com
