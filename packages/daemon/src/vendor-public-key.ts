/**
 * Public Ed25519 verification material bundled with this build.
 *
 * This historical RevDev issuer key is not evidence that the hosted RevealUI
 * signer uses the same key. Hosted issuance and paid dispatch require both a
 * valid local signature and exact hosted registration. Supported issuer trust
 * provisioning and key rotation remain required before claiming automatic
 * activation for hosted credentials. Never replace this key from unverified
 * remote material or use a machine override as a rotation procedure.
 */
export const DEFAULT_VENDOR_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASYqUILNyK2frt8BDbW01N4+/Vmgsf+b+6Z+xJUT4Tho=
-----END PUBLIC KEY-----`;
