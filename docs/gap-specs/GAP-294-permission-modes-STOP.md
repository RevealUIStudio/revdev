---
type: note
date: 2026-09-23
status: unblocked
gap: GAP-294
repos: revdev
---

# GAP-294 — design vendored

The countersigned design was missing from this checkout when the first
pass stopped. It is now in this directory:

- [`GAP-294-permission-modes-design.md`](./GAP-294-permission-modes-design.md) — §4 and §5 countersigned 2026-07-18
- [`GAP-294-permission-shadow-soak-review.md`](./GAP-294-permission-shadow-soak-review.md) — historical soak note; default stays `shadow` until the owner flips it

Implementation follows that design. `REVDEV_PERMISSION_MODE` unset still
resolves to `shadow`. An unknown value fails closed to `manual` (design
invariant I2). Phase 3, the install-default flip, is owner-only.
