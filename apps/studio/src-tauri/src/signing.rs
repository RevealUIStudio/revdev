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
            // git metadata reads — signature-required so they are scoped to the
            // verified signer (no cross-agent branch/history/dirty-path leak).
            | "git.status"
            | "git.listBranches"
            | "git.log"
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

/// Load the identity from the default keystore, creating + persisting a fresh
/// one (with a stable per-install agentId) on first run.
pub fn load_or_create_identity() -> Result<StudioIdentity, String> {
    load_or_create_at(&default_identity_path()?)
}

/// Keystore load/create against an explicit path (seam for tests).
pub fn load_or_create_at(path: &Path) -> Result<StudioIdentity, String> {
    if path.exists() {
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
    fs::write(
        path,
        serde_json::to_string(&stored).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write identity: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ed25519_dalek::{Verifier, VerifyingKey};
    use serde_json::json;

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
        assert!(!requires_signature("git.status"));
        assert!(!requires_signature("ping"));
    }
}
