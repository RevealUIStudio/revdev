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
2. **Identity is cryptographically bound.** Registering a new key for an **existing** `agentId`
   requires authentication by the current (not-yet-superseded) key (proof-of-possession at
   `identity.rotate`; paramsHash binds the new key). **Identity model in two stages:**
   - **Interim (shipped):** `(agentId, fingerprint)` pairs are pre-provisioned in a root-owned trust
     anchor. The anchor is the enrollment policy root; anchor-lint + `harness.health` consistency
     assertions detect misconfiguration eagerly. `identity.rotate` enforces PoP from the active key.
   - **Durable target (D1, next lane):** self-certifying principal — `agentId` becomes a function of
     the key fingerprint (intrinsically unspoofable, no anchor correctness dependency). Human-readable
     coordination names (`conductor`, `agent-system`) become a **mutable alias → principal** mapping
     claimed at enrollment with proof of key possession. The anchor degrades from *the* authorization
     root to **alias-claim policy**.
   2a. **Client-owned vs. daemon-minted identities are explicitly distinct.** A `key_origin` column
   (`'client' | 'daemon'`) tracks whether the private key lives in the client vault (Studio/Windows)
   or was minted by the daemon for headless hooks. Only `'client'` identities may own filesystem
   roots; `'daemon'` identities are explicitly outside the Pro isolation guarantee.
3. **Layer A is the RPC gate, not the sole wall.** (A) daemon per-agent authorization (signature gate,
   `requireRoot`, `requireVerifiedAgent`) closes the RPC chokepoint and provides attribution — this is
   what the isolation lane implements. (B) OS-level per-agent sandboxing (UID/namespace, bind-mounted
   roots per agent) is the durable boundary against *direct* ext4 access and hardlink/inode aliasing.
   Layer A ships now; Layer B is on the roadmap and is the productized Pro guarantee. Do not describe
   the daemon signature gate as the sole wall.
4. **git handlers neutralize repo-local escape hatches** (`core.hooksPath`, `protocol.ext`,
   `core.fsmonitor`, `core.sshCommand`, config includes) so confined RPC cannot become shared-UID RCE.
   *(The four core flags shipped on #162; the lane completes the remainder.)*
5. **The per-agent boundary is unconditional** — never license/Pro-gated. Pro gates coordination
   *features* (multi-agent mail, tasks, memory), never the security boundary.

## Architecture Decisions (owner-ruled 2026-06-25)

These three decisions were owner-ruled during the B6 isolation lane and are recorded here as ADR
amendments. They feed the Pro-GA gate.

### D1 — Identity (durable target: self-certifying principal)

The durable identity model is a **self-certifying principal**: `agentId` is derived from the key
fingerprint, making it intrinsically unspoofable. Human-readable names become aliases. This eliminates
the anchor-correctness trust assumption entirely. **Interim (this slice):** anchor + PoP rotation is
cryptographically secure for the first sale; anchor-lint + `harness.health` consistency assertions
mitigate mis-provisioning risk. D1 proper (DID-format change, alias table + migration) is the
next-lane target; it does not block Pro GA.

### D2 — Daemon-minted coordination trust boundary (disclosed)

Daemon-minted (headless-hook) identities **may never own filesystem roots**. Enforced in `project.open`
via `key_origin = 'daemon'` rejection. These identities retain coordination access (mail, tasks,
memory) via the daemon's socket-bind + `session.register` trust — **not** per-request Ed25519
signatures. This is a weaker, free-tier boundary. The security attestation must state plainly:

> Daemon-minted coordination rests on the `0600` socket + register binding. Per-request crypto is
> enforced for client-owned identities on all `MUTATING_OR_CONTENT_METHODS`. The Pro isolation
> guarantee (file I/O isolation between agents) applies only to client-owned identities; daemon-minted
> identities cannot trigger file I/O at all.

The durable endgame (per-request signing for headless coordination, key pulled from revvault) is
tolerated as a future improvement; it is not blocking because the blast radius of socket-trust is
coordination metadata only.

### D3 — Root-ownership persistence and restart safety

`(dev, ino)`-keyed ownership (and grants) is persisted in the daemon PGlite `project_roots` table,
`UNIQUE(dev, ino)`, outside any registerable root and outside `file.*` reach. Roots for still-active
sessions are restored on daemon startup (`restoreProjectRoots`). This prevents restart land-grab
(B6 item 11). Orphaned rows (session ended before restart) are pruned at startup.

## Consequences

- The in-authz slice (Layer A) is implemented by the isolation lane; OS sandboxing (Layer B) is on
  the roadmap, not deferred indefinitely.
- **Multi-agent Pro tier GA is gated** on the isolation lane landing complete (all MUST items + the
  adversarial test matrix in `adversarial-isolation.test.ts`). Single-agent zero-9P ships in the
  meantime.
- Security / SOC attestation docs MUST describe: (a) the per-agent RPC boundary and identity model
  as actually enforced; (b) the daemon-minted coordination trust disclosure (D2); (c) that Layer A is
  the RPC gate and Layer B (OS sandboxing) is the durable wall — not prior implicit single-trust-domain
  framing.
