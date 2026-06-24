# ADR: Zero-9P — Agent-vs-Agent Isolation & Identity Provisioning

- **Status:** Accepted (2026-06-24)
- **Supersedes:** the implicit single-trust-domain assumption in
  `docs/decisions/2026-06-23-daemon-in-wsl-zero-9p.md` (the parent zero-9P ADR).
- **Tracking:** `docs/lanes/multi-agent-filesystem-isolation/plan.md`

## Context

The parent ADR's threat model is **host-process-vs-WSL-daemon only**. A 2026-06-24 adversarial
security review (verified against the daemon code) found it is **silent on two boundaries** that the
productized multi-agent (Pro) configuration makes load-bearing, plus one escape hatch:

1. **Agent-vs-agent.** Roots are a global set (`filegit.ts:42`); any agent with a valid signature
   reaches any root any other agent opened. Agents are implicitly one trust domain.
2. **Identity provisioning/rotation.** The "verified agentId" is a **self-asserted DID**
   (`did.ts:52` string-split; `isValidAgentId` checks grammar only); `session.register` mints and
   rotates identities **unauthenticated** (`server.ts:108` `IDENTITY_EXEMPT`; `forceRotate` supersede
   at `:627`/`:684`) — an impersonation / account-takeover primitive.
3. **git escape hatch.** Mutation handlers do not neutralize repo-local hooks/config (`vcs.ts:89`
   bare `spawn`), so a hook an agent writes into its **own** root executes as the daemon UID —
   defeating the traversal-confinement this ADR already claims, single-agent or not.

## Decision

1. **Each agent is a distinct security principal.** An agent may read/write/commit only in roots it
   owns or is explicitly granted. Agent-vs-agent is now an explicit trust boundary.
2. **Identity is unspoofable.** `agentId` is **self-certifying** (derived from the key fingerprint)
   or **daemon-minted**; registering a new key for an **existing** `agentId` requires authentication
   by the current (not-yet-superseded) key. No unauthenticated mint/rotate of an existing identity.
3. **Two-layer enforcement.** (A) daemon per-agent authorization closes the RPC chokepoint and
   provides attribution; (B) OS-level per-agent sandboxing (UID/namespace, bind-mounted roots) is the
   durable boundary against *direct* ext4 access and hardlink/inode aliasing, and is the productized
   Pro guarantee. The daemon signature is reframed as **enforcement-at-the-RPC + attribution**, not
   the sole wall.
4. **git handlers neutralize repo-local escape hatches** (`core.hooksPath`, `protocol.ext`,
   `core.fsmonitor`, `core.sshCommand`, config includes) so confined RPC cannot become shared-UID RCE.
   *(The four core flags shipped on #162; the lane completes the remainder.)*
5. **The per-agent boundary is unconditional** — never license/Pro-gated. Pro gates coordination
   *features*, never the security boundary.

## Consequences

- The in-authz slice (Layer A) is implemented by the isolation lane; OS sandboxing (Layer B) is on
  the roadmap, not deferred indefinitely.
- **Multi-agent Pro tier GA is gated** on the isolation lane landing complete (all MUST items + the
  adversarial test matrix). Single-agent zero-9P ships in the meantime.
- Security / SOC attestation docs MUST describe the per-agent boundary and the identity model as
  actually enforced — not the prior implicit single-trust-domain framing.
