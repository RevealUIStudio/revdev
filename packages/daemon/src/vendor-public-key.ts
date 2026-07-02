/**
 * Baked-in default vendor Ed25519 public key (PEM).
 *
 * This is PUBLIC verification material, not a secret. It can only VERIFY license
 * JWT signatures, never mint them; the private half never leaves revvault
 * (`revdev/license-signing-private-key`). Baking it in lets a buyer activate with
 * only their license JWT (`REVEALUI_LICENSE_KEY`) and no second env var on the
 * happy path. `REVDEV_LICENSE_PUBLIC_KEY` still overrides this for key rotation
 * or testing.
 *
 * Canonical source: revvault `revdev/license-signing-public-key` (ADR 2026-06-06
 * signing-key consolidation). The signing keypair rotates on a roughly 1-year
 * owner-driven cadence; when it does, refresh this constant from that revvault
 * path (public half only).
 */
export const DEFAULT_VENDOR_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASYqUILNyK2frt8BDbW01N4+/Vmgsf+b+6Z+xJUT4Tho=
-----END PUBLIC KEY-----`;
