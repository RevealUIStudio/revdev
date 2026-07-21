//! Ed25519 request signing for the zero-9P daemon RPC envelope (ADR P1).
//!
//! Studio holds its per-install Ed25519 private key in its own (Windows-local)
//! vault and sends only the public half to the daemon at `session.register`.
//! Every mutating or content-returning RPC then carries an `x-revdev-signature`
//! envelope so the daemon can prove the call came from the key holder — a host
//! process that can reach the relay but lacks the key cannot read project files
//! or mutate the repo.
//!
//! The envelope is byte-compatible with the daemon's `agent-identity-crypto.ts`
//! (`signEnvelope` / `hashParams` / `computeFingerprint`). The cross-language
//! contract is locked by the vectors in the test module below, which are taken
//! verbatim from the TypeScript implementation.

use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// The fixed header for every envelope: `{"alg":"EdDSA","typ":"jws"}`.
/// Hardcoded so the bytes that get base64url-encoded and signed exactly match
/// the daemon's `JSON.stringify({ alg: 'EdDSA', typ: 'jws' })`.
const HEADER_JSON: &str = r#"{"alg":"EdDSA","typ":"jws"}"#;

/// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410). The 32-byte raw
/// public key follows, giving the 44-byte SPKI the daemon stores + verifies.
const SPKI_ED25519_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// Methods that MUST be signed — every mutation and content-returning read.
/// Mirrors the daemon's `MUTATING_OR_CONTENT_METHODS` (server.ts); anything
/// not listed is a payload-free coordination call that stays signature-optional.
pub fn requires_signature(method: &str) -> bool {
    matches!(
        method,
        "file.read"
            | "file.write"
            | "file.delete"
            | "file.stat"
            | "git.stageFile"
            | "git.unstageFile"
            | "git.discardFile"
            | "git.createBranch"
            | "git.switchBranch"
            | "git.deleteBranch"
            | "git.commit"
            | "git.push"
            | "git.pull"
            | "git.diffFile"
            | "git.diffContent"
            | "git.readBlobAtHead"
            | "git.readBlobAtIndex"
            // Root registration is signature-required so the daemon records the
            // root under the verified signer (per-agent root scoping). MUST
            // mirror the daemon's MUTATING_OR_CONTENT_METHODS set (server.ts).
            | "project.open"
            // Key rotation: proof-of-possession — signed by the current key,
            // paramsHash binds the new public key. MUST mirror server.ts.
            | "identity.rotate"
            // Grant/revoke cross-agent root access: owner-only, signature-required.
            // MUST mirror server.ts MUTATING_OR_CONTENT_METHODS.
            | "project.grant"
            | "project.revoke"
            // git metadata reads — signature-required so they are scoped to the
            // verified signer (no cross-agent branch/history/dirty-path leak).
            | "git.status"
            | "git.listBranches"
            | "git.log"
            // worktree mutations — `git worktree add/remove` shell out as the
            // daemon UID, so they are signature-required (the B-WT fix). MUST
            // mirror the daemon's MUTATING_OR_CONTENT_METHODS set (server.ts).
            | "worktree.create"
            | "worktree.remove"
            // agent.* PTY/exec surface — `agent.spawn` forks a caller-supplied
            // command as the daemon UID (unsigned-RCE) and stop/input/resize/
            // output drive another agent's live PTY. Signature-required so the
            // native client signs them and the daemon binds the verified signer.
            // MUST mirror server.ts MUTATING_OR_CONTENT_METHODS.
            | "agent.spawn"
            | "agent.stop"
            | "agent.input"
            | "agent.resize"
            | "agent.output"
            // agent.list returns another-agent-invisible process metadata and
            // agent.remove kills + prunes a process; both are self-scoped to the
            // verified signer. MUST mirror server.ts MUTATING_OR_CONTENT_METHODS.
            | "agent.list"
            | "agent.remove"
            // session.end evicts the target's project roots and kills its PTYs.
            // Signature-required so the daemon can self-scope it to the verified
            // signer instead of a caller-supplied `sessionId`.
            | "session.end"
            // harness.prune reaches the SAME eviction primitive as session.end,
            // but fans it across every matched session rather than one. It was
            // identity-exempt and unsigned, so one frame from any same-UID
            // socket peer ended the whole fleet's sessions and killed every PTY
            // (`staleDays: 0` selects `started_at < NOW()`). GAP-312.
            // MUST mirror server.ts MUTATING_OR_CONTENT_METHODS.
            | "harness.prune"
            // GAP-294 Phase 1 — approval decisions are signature-required.
            | "permission.decide"
            // Phase 2 — operator mode override.
            | "permission.setMode"
    )
}

fn b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Deterministic JSON canonicalization matching the daemon's `canonicalizeJSON`:
/// object keys sorted, no insignificant whitespace, `JSON.stringify` semantics
/// for primitives.
fn canonicalize(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let pairs: Vec<String> = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).expect("string key always serializes"),
                        canonicalize(&map[*k]),
                    )
                })
                .collect();
            format!("{{{}}}", pairs.join(","))
        }
        Value::Array(arr) => {
            let items: Vec<String> = arr.iter().map(canonicalize).collect();
            format!("[{}]", items.join(","))
        }
        other => serde_json::to_string(other).expect("json value always serializes"),
    }
}

/// `base58(sha256(`${method}:${canonicalizeJSON(params ?? {})}`))` — must match
/// the daemon's `hashParams` exactly, since the daemon recomputes it from the
/// params as received and rejects a mismatch.
pub fn hash_params(method: &str, params: &Value) -> String {
    let empty = Value::Object(serde_json::Map::new());
    let p = if params.is_null() { &empty } else { params };
    let mut hasher = Sha256::new();
    hasher.update(method.as_bytes());
    hasher.update(b":");
    hasher.update(canonicalize(p).as_bytes());
    bs58::encode(hasher.finalize()).into_string()
}

/// `base58(sha256(rawPublicKey))` — the daemon's `computeFingerprint`.
fn fingerprint_of(raw: &[u8; 32]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw);
    bs58::encode(hasher.finalize()).into_string()
}

/// Build the SPKI PEM the daemon stores and verifies against. Node's
/// `crypto.verify` parses this and the daemon's `spkiPemToRaw` recovers the
/// trailing 32 raw bytes.
fn public_key_pem(raw: &[u8; 32]) -> String {
    use base64::Engine;
    let mut der = Vec::with_capacity(44);
    der.extend_from_slice(&SPKI_ED25519_PREFIX);
    der.extend_from_slice(raw);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&der);
    let mut pem = String::from("-----BEGIN PUBLIC KEY-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).expect("base64 is ascii"));
        pem.push('\n');
    }
    pem.push_str("-----END PUBLIC KEY-----\n");
    pem
}

#[derive(Serialize)]
struct SignaturePayload<'a> {
    did: &'a str,
    kid: &'a str,
    nonce: String,
    ts: i64,
    method: &'a str,
    #[serde(rename = "paramsHash")]
    params_hash: String,
}

/// A per-install Studio signing identity. Holds the Ed25519 private key; the
/// daemon only ever sees `public_key_pem`.
pub struct StudioIdentity {
    signing_key: SigningKey,
    pub agent_id: String,
    pub fingerprint: String,
    pub did: String,
    pub public_key_pem: String,
}

/// Signing identity for a daemon-minted local agent (Ubuntu Inference Snap,
/// Ollama, or other headless runner). Built from the one-shot `privateKeyPem`
/// returned by `session.register` so Studio can sign `session.end` for that
/// agent without reusing the Studio UI's client-owned key.
pub struct EphemeralAgentIdentity {
    signing_key: SigningKey,
    pub did: String,
    pub fingerprint: String,
}

impl EphemeralAgentIdentity {
    /// Reconstruct from daemon register response (`did` + PKCS8 `privateKeyPem`).
    /// Node `generateKeyPairSync('ed25519')` PKCS8 DER ends with the 32-byte seed.
    pub fn from_daemon_mint(did: &str, private_key_pem: &str) -> Result<Self, String> {
        let fingerprint = did
            .rsplit(':')
            .next()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("invalid did (no fingerprint): {did}"))?
            .to_string();
        let signing_key = signing_key_from_pkcs8_pem(private_key_pem)?;
        Ok(Self {
            signing_key,
            did: did.to_string(),
            fingerprint,
        })
    }

    pub fn sign_request(&self, method: &str, params: &Value, now_unix_secs: i64) -> String {
        let header_b64 = b64url(HEADER_JSON.as_bytes());
        let mut nonce_bytes = [0u8; 16];
        {
            use rand::RngCore;
            rand::rng().fill_bytes(&mut nonce_bytes);
        }
        let payload = SignaturePayload {
            did: &self.did,
            kid: &self.fingerprint,
            nonce: hex::encode(nonce_bytes),
            ts: now_unix_secs,
            method,
            params_hash: hash_params(method, params),
        };
        let payload_json = serde_json::to_string(&payload).expect("payload serializes");
        let payload_b64 = b64url(payload_json.as_bytes());
        let message = format!("{header_b64}.{payload_b64}");
        let signature = self.signing_key.sign(message.as_bytes());
        let sig_b64 = b64url(&signature.to_bytes());
        format!("{message}.{sig_b64}")
    }
}

/// Extract the 32-byte Ed25519 seed from a PKCS8 PEM private key (Node/OpenSSL
/// shape). The seed is the trailing 32 bytes of the DER payload.
fn signing_key_from_pkcs8_pem(pem: &str) -> Result<SigningKey, String> {
    use base64::Engine;
    let b64: String = pem
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("-----"))
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("invalid private key PEM base64: {e}"))?;
    if der.len() < 32 {
        return Err("invalid private key PEM: too short".to_string());
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&der[der.len() - 32..]);
    Ok(SigningKey::from_bytes(&seed))
}

impl StudioIdentity {
    /// Generate a fresh identity from OS randomness.
    pub fn generate(agent_id: String) -> Self {
        use rand::RngCore;
        let mut seed = [0u8; 32];
        rand::rng().fill_bytes(&mut seed);
        Self::from_seed(agent_id, &seed)
    }

    /// Reconstruct an identity from a stored 32-byte seed (vault round-trip).
    pub fn from_seed(agent_id: String, seed: &[u8; 32]) -> Self {
        let signing_key = SigningKey::from_bytes(seed);
        let raw = signing_key.verifying_key().to_bytes();
        let fingerprint = fingerprint_of(&raw);
        let did = format!("did:revfleet:{agent_id}:{fingerprint}");
        let public_key_pem = public_key_pem(&raw);
        Self {
            signing_key,
            agent_id,
            fingerprint,
            did,
            public_key_pem,
        }
    }

    /// The 32-byte private seed as hex — what gets persisted to the vault.
    pub fn seed_hex(&self) -> String {
        hex::encode(self.signing_key.to_bytes())
    }

    /// Produce the serialized `x-revdev-signature` envelope for a request. The
    /// `params` must be exactly what is sent on the wire (including any injected
    /// `actorAgentId`), since the daemon recomputes `paramsHash` over them.
    pub fn sign_request(&self, method: &str, params: &Value, now_unix_secs: i64) -> String {
        let header_b64 = b64url(HEADER_JSON.as_bytes());
        let mut nonce_bytes = [0u8; 16];
        {
            use rand::RngCore;
            rand::rng().fill_bytes(&mut nonce_bytes);
        }
        let payload = SignaturePayload {
            did: &self.did,
            kid: &self.fingerprint,
            nonce: hex::encode(nonce_bytes),
            ts: now_unix_secs,
            method,
            params_hash: hash_params(method, params),
        };
        let payload_json = serde_json::to_string(&payload).expect("payload serializes");
        let payload_b64 = b64url(payload_json.as_bytes());
        let message = format!("{header_b64}.{payload_b64}");
        let signature = self.signing_key.sign(message.as_bytes());
        let sig_b64 = b64url(&signature.to_bytes());
        format!("{message}.{sig_b64}")
    }
}

// ---------------------------------------------------------------------------
// Per-install keystore
//
// The signing seed lives in a small JSON file under the OS-local app-data dir
// (`dirs::data_local_dir()`), NOT in a project path. On Windows that resolves
// to %LOCALAPPDATA%, which is on the Windows profile — never ext4 / never
// across the 9P boundary. Deliberately lighter than the age-vault so basic
// file/git editing works out of the box without a vault-init step (RevDev is
// a free daily-driver editor); the file is created 0600 on unix.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct StoredIdentity {
    #[serde(rename = "agentId")]
    agent_id: String,
    #[serde(rename = "seedHex")]
    seed_hex: String,
}

/// Default keystore path: `<local-data>/revealui-studio/studio-identity.json`.
pub fn default_identity_path() -> Result<PathBuf, String> {
    let dir = dirs::data_local_dir().ok_or_else(|| "no local data directory".to_string())?;
    Ok(dir.join("revealui-studio").join("studio-identity.json"))
}

/// Lock the identity file (which holds the Ed25519 signing private seed) to the
/// current OS user only — strip inherited ACEs + grant owner on Windows, 0600
/// on unix. Idempotent and fail-CLOSED: returns Err if the lock cannot be
/// applied, so the caller can delete the file rather than leave an unprotected
/// private key. Applied on BOTH the create AND the load path, so a file written
/// by pre-#173 code (inherited %LOCALAPPDATA% ACL, never owner-locked) is
/// re-locked on the next load.
fn lock_identity_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Fail-closed (was `let _ =`): a chmod failure must not leave the seed
        // group/other-readable.
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod 0600 signing key: {e}"))?;
    }
    #[cfg(windows)]
    {
        // Default %LOCALAPPDATA% ACLs can be broader than owner-only; strip
        // inherited ACEs and grant only the current user.
        let user = std::env::var("USERNAME")
            .map_err(|_| "cannot resolve %USERNAME% to ACL the signing key".to_string())?;
        let status = std::process::Command::new("icacls")
            .arg(path)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .arg(format!("{user}:F"))
            .status()
            .map_err(|e| format!("icacls (lock signing key) failed to run: {e}"))?;
        if !status.success() {
            return Err("icacls (lock signing key) returned non-zero".to_string());
        }
    }
    Ok(())
}

/// Load the identity from the default keystore, creating + persisting a fresh
/// one (with a stable per-install agentId) on first run.
pub fn load_or_create_identity() -> Result<StudioIdentity, String> {
    load_or_create_at(&default_identity_path()?)
}

/// Keystore load/create against an explicit path (seam for tests).
pub fn load_or_create_at(path: &Path) -> Result<StudioIdentity, String> {
    if path.exists() {
        // Re-lock on EVERY load: a file written by pre-#173 code inherited the
        // broader %LOCALAPPDATA% ACL (or a unix umask) and was never owner-
        // locked. Fail-closed — never read/use a signing key we could not
        // secure; delete it so the next run regenerates + re-provisions.
        if let Err(e) = lock_identity_file(path) {
            let _ = fs::remove_file(path);
            return Err(format!("cannot secure existing signing key {}: {e}", path.display()));
        }
        let data = fs::read_to_string(path).map_err(|e| format!("read identity: {e}"))?;
        let stored: StoredIdentity =
            serde_json::from_str(&data).map_err(|e| format!("parse identity: {e}"))?;
        let bytes =
            hex::decode(stored.seed_hex.trim()).map_err(|e| format!("decode signing seed: {e}"))?;
        let seed: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| "signing seed must be 32 bytes".to_string())?;
        return Ok(StudioIdentity::from_seed(stored.agent_id, &seed));
    }

    let agent_id = format!("studio-{}", uuid::Uuid::new_v4());
    let identity = StudioIdentity::generate(agent_id);
    let stored = StoredIdentity {
        agent_id: identity.agent_id.clone(),
        seed_hex: identity.seed_hex(),
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create identity dir: {e}"))?;
    }
    // Create the file EMPTY and lock it BEFORE writing the seed, so the private
    // seed is never briefly on disk under inherited ACLs (TOCTOU). Fail-closed.
    fs::write(path, b"").map_err(|e| format!("create identity file: {e}"))?;
    if let Err(e) = lock_identity_file(path) {
        let _ = fs::remove_file(path);
        return Err(format!("cannot secure new signing key {}: {e}", path.display()));
    }
    // The file is now owner-only; write the seed into it (truncate-in-place
    // preserves the DACL/mode just set).
    fs::write(path, serde_json::to_string(&stored).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write identity: {e}"))?;
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ed25519_dalek::{Verifier, VerifyingKey};
    use serde_json::json;

    #[cfg(unix)]
    #[test]
    fn load_relocks_a_world_readable_legacy_identity() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("revdev-seedacl-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("studio-identity.json");
        let _ = std::fs::remove_file(&path);

        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;

        // Fresh create → owner-only (0600).
        let created = load_or_create_at(&path).expect("create identity");
        assert_eq!(mode(&path), 0o600, "a freshly created signing key must be 0600");

        // Simulate a pre-#173 file: broaden to group/other-readable.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(mode(&path), 0o644);

        // Load again → must RE-LOCK to 0600 without regenerating the identity.
        let loaded = load_or_create_at(&path).expect("load identity");
        assert_eq!(mode(&path), 0o600, "load must re-lock a legacy key to 0600");
        assert_eq!(created.agent_id, loaded.agent_id, "re-lock must not regenerate the key");
        assert_eq!(created.fingerprint, loaded.fingerprint);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Vectors taken verbatim from the daemon's agent-identity-crypto.ts (the
    // cross-language contract). If these drift, the Rust client's signatures
    // will be rejected by the daemon — fail loudly here instead.
    #[test]
    fn canonicalize_sorts_keys() {
        assert_eq!(
            canonicalize(&json!({ "repoPath": "/r", "filePath": "a.txt" })),
            r#"{"filePath":"a.txt","repoPath":"/r"}"#
        );
    }

    #[test]
    fn hash_params_matches_typescript_vectors() {
        assert_eq!(
            hash_params(
                "file.read",
                &json!({ "repoPath": "/r", "filePath": "a.txt" })
            ),
            "5u2KAxURNfuFSZ2AsbRXtKWq22qUuW39xcvtb799YHWS"
        );
        // Key order on the wire is irrelevant — canonicalization sorts.
        assert_eq!(
            hash_params(
                "file.read",
                &json!({ "filePath": "a.txt", "repoPath": "/r" })
            ),
            "5u2KAxURNfuFSZ2AsbRXtKWq22qUuW39xcvtb799YHWS"
        );
        assert_eq!(
            hash_params("git.status", &json!({})),
            "HeEMejzRaDY6X6fBcrRz95BG6UFHcmmM9HYpTmzMQgbw"
        );
        assert_eq!(
            hash_params(
                "git.commit",
                &json!({ "repoPath": "/r", "message": "hello world" })
            ),
            "6zw5FKjBD8Tcsp6iNgVtEiv4X4UCGPeoiJVp26U8ULFu"
        );
    }

    #[test]
    fn null_params_hash_as_empty_object() {
        assert_eq!(
            hash_params("git.status", &Value::Null),
            hash_params("git.status", &json!({}))
        );
    }

    #[test]
    fn ephemeral_agent_from_pkcs8_trailing_seed() {
        use base64::Engine;
        let seed = [9u8; 32];
        // Minimal DER: trailing 32 bytes are the seed (matches our parser).
        let der = seed.to_vec();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&der);
        let pem = format!("-----BEGIN PRIVATE KEY-----\n{b64}\n-----END PRIVATE KEY-----\n");
        let studio = StudioIdentity::from_seed("snap-agent".into(), &seed);
        let eph = EphemeralAgentIdentity::from_daemon_mint(&studio.did, &pem).unwrap();
        assert_eq!(eph.did, studio.did);
        assert_eq!(eph.fingerprint, studio.fingerprint);
        // Signatures for the same method/params/ts differ by nonce but both verify shape.
        let params = json!({ "exitSummary": "test" });
        let env = eph.sign_request("session.end", &params, 1_700_000_000);
        assert_eq!(env.split('.').count(), 3);
    }

    #[test]
    fn identity_is_deterministic_from_seed() {
        let seed = [7u8; 32];
        let a = StudioIdentity::from_seed("agent-x".into(), &seed);
        let b = StudioIdentity::from_seed("agent-x".into(), &seed);
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_eq!(a.did, b.did);
        assert!(a.did.starts_with("did:revfleet:agent-x:"));
        assert_eq!(a.seed_hex(), hex::encode(seed));
    }

    #[test]
    fn public_key_pem_is_valid_spki_with_trailing_raw_key() {
        let id = StudioIdentity::from_seed("agent-x".into(), &[3u8; 32]);
        let raw = id.signing_key.verifying_key().to_bytes();
        assert!(id
            .public_key_pem
            .starts_with("-----BEGIN PUBLIC KEY-----\n"));
        let b64: String = id
            .public_key_pem
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect();
        let der = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        assert_eq!(der.len(), 44);
        // The daemon's spkiPemToRaw recovers exactly these trailing 32 bytes.
        assert_eq!(&der[12..], &raw);
    }

    #[test]
    fn envelope_signature_verifies_and_has_three_parts() {
        let id = StudioIdentity::from_seed("agent-x".into(), &[9u8; 32]);
        let params = json!({ "repoPath": "/r", "filePath": "a.txt" });
        let env = id.sign_request("file.read", &params, 1_700_000_000);
        let parts: Vec<&str> = env.split('.').collect();
        assert_eq!(parts.len(), 3);

        // Header decodes to the exact bytes the daemon expects.
        let header = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[0])
            .unwrap();
        assert_eq!(std::str::from_utf8(&header).unwrap(), HEADER_JSON);

        // Signature verifies over `${header}.${payload}` with the public key.
        let raw = id.signing_key.verifying_key().to_bytes();
        let vk = VerifyingKey::from_bytes(&raw).unwrap();
        let message = format!("{}.{}", parts[0], parts[1]);
        let sig_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[2])
            .unwrap();
        let sig = ed25519_dalek::Signature::from_slice(&sig_bytes).unwrap();
        assert!(vk.verify(message.as_bytes(), &sig).is_ok());
    }

    #[test]
    fn keystore_round_trips_a_stable_identity() {
        let dir = std::env::temp_dir().join(format!("revdev-id-{}", uuid::Uuid::new_v4()));
        let path = dir.join("studio-identity.json");
        let a = load_or_create_at(&path).expect("create");
        let b = load_or_create_at(&path).expect("load");
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_eq!(a.agent_id, b.agent_id);
        assert_eq!(a.did, b.did);
        assert!(a.agent_id.starts_with("studio-"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn requires_signature_matches_daemon_set() {
        assert!(requires_signature("file.read"));
        assert!(requires_signature("git.commit"));
        assert!(requires_signature("project.open"));
        assert!(requires_signature("git.status"));
        assert!(requires_signature("git.log"));
        assert!(requires_signature("worktree.create"));
        assert!(requires_signature("worktree.remove"));
        assert!(requires_signature("agent.spawn"));
        assert!(requires_signature("agent.stop"));
        assert!(requires_signature("agent.input"));
        assert!(requires_signature("agent.resize"));
        assert!(requires_signature("agent.output"));
        assert!(requires_signature("agent.list"));
        assert!(requires_signature("agent.remove"));
        assert!(requires_signature("session.end"));
        // GAP-312: same eviction primitive as session.end, fleet-wide fan-out.
        assert!(requires_signature("harness.prune"));
        // GAP-294 Phase 1.
        assert!(requires_signature("permission.decide"));
        assert!(requires_signature("permission.setMode"));
        assert!(!requires_signature("ping"));
        assert!(!requires_signature("session.list"));
        // harness.health is a read; it stays unsigned. Guards against a
        // copy-paste that gates the wrong half of the harness.* surface.
        assert!(!requires_signature("harness.health"));
        assert!(!requires_signature("permission.pending"));
    }
}
