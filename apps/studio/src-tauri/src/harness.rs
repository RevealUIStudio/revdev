//! JSON-RPC 2.0 client for the RevDev Harness daemon.
//!
//! Connects to the daemon's Unix domain socket at
//! `~/.local/share/revealui/harness.sock` and sends newline-delimited
//! JSON-RPC requests.
//!
//! Resilience: each call is wrapped in a 10s timeout with up to 3 retries
//! (100ms, 500ms, 2s backoff) for transient IO errors. Parse failures and
//! daemon-level RPC errors are never retried.

use crate::signing;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::sync::OnceCell;
use tokio::time::{timeout, Duration};

const SOCKET_REL_PATH: &str = ".local/share/revealui/harness.sock";

/// User-facing copy when the Windows WSL relay exits before a JSON-RPC line.
/// Kept off the `not(unix)` gate so Linux CI can lock the wording.
#[cfg_attr(unix, allow(dead_code))]
pub(crate) fn relay_closed_message(stderr: &str) -> String {
    let hint = stderr.trim();
    let base = "Relay closed without response. The agent daemon in WSL is not running. Open Setup from the sidebar, then try Agent again.";
    if hint.is_empty() {
        return base.to_string();
    }
    format!("{base} ({hint})")
}

/// After a failed WSL relay spawn, skip new `wsl.exe` children until `until`.
pub(crate) fn relay_spawn_on_cooldown(
    now: std::time::Instant,
    until: Option<std::time::Instant>,
) -> bool {
    until.is_some_and(|t| now < t)
}

/// Per-attempt timeout for daemon RPC calls. Shared by both transports.
const RPC_TIMEOUT: Duration = Duration::from_secs(10);

/// Maximum retry attempts for transient failures.
const MAX_RETRIES: usize = 3;

/// Backoff delays between retry attempts (ms).
const RETRY_DELAYS_MS: [u64; 3] = [100, 500, 2000];

/// Native Unix socket path (also honors REVDEV_TEST_SOCKET). The Windows
/// transport doesn't use this — it constructs the WSL-side path in the relay
/// command — so it's Unix-only to avoid a dead-code warning there.
#[cfg(unix)]
fn socket_path() -> String {
    // Allow override for integration tests
    if let Ok(path) = std::env::var("REVDEV_TEST_SOCKET") {
        return path;
    }
    if let Some(home) = dirs::home_dir() {
        format!("{}/{}", home.display(), SOCKET_REL_PATH)
    } else {
        "/tmp/revealui-harness.sock".to_string()
    }
}

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
struct JsonRpcRequest<'a> {
    jsonrpc: &'static str,
    id: u64,
    method: &'a str,
    params: serde_json::Value,
    /// Ed25519 envelope for MUTATING_OR_CONTENT_METHODS. Omitted from the wire
    /// (the daemon treats absence as unsigned) for signature-optional calls.
    #[serde(rename = "x-revdev-signature", skip_serializing_if = "Option::is_none")]
    signature: Option<String>,
}

#[derive(Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: String,
    #[allow(dead_code)]
    id: serde_json::Value,
    result: Option<serde_json::Value>,
    error: Option<JsonRpcError>,
}

#[derive(Deserialize)]
struct JsonRpcError {
    #[allow(dead_code)]
    code: i64,
    message: String,
}

/// Cached agent ID for this Studio process — populated on first successful
/// session.register, then injected as `actorAgentId` on every subsequent call.
static STUDIO_AGENT_ID: OnceCell<String> = OnceCell::const_new();

/// The per-install Ed25519 signing identity, loaded from the local keystore on
/// first use. The daemon only ever receives `public_key_pem`; the private seed
/// stays in the OS-local app-data dir (never ext4 / never across 9P).
static STUDIO_IDENTITY: OnceCell<signing::StudioIdentity> = OnceCell::const_new();

/// Lazily load (or create on first run) the signing identity. The keystore I/O
/// is a tiny local file read, run on a blocking thread to keep the async
/// runtime clear.
async fn studio_identity() -> Result<&'static signing::StudioIdentity, String> {
    STUDIO_IDENTITY
        .get_or_try_init(|| async {
            tokio::task::spawn_blocking(signing::load_or_create_identity)
                .await
                .map_err(|e| format!("identity load task failed: {e}"))?
        })
        .await
}

/// Register this Studio instance as a daemon session (idempotent).
///
/// Studio opens a fresh socket per RPC call, so we can't rely on per-socket
/// identity surviving across calls. Instead we register once — supplying our
/// public key so the daemon binds this stable agentId to it — cache the
/// returned agent ID, and pass it as `actorAgentId` on every later call.
pub async fn ensure_session() -> Result<String, String> {
    if let Some(id) = STUDIO_AGENT_ID.get() {
        return Ok(id.clone());
    }
    let identity = studio_identity().await?;
    let result = rpc_call_raw(
        "session.register",
        serde_json::json!({
            "agentId": identity.agent_id,
            "agentName": "studio-ui",
            "workDir": std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            "backend": "studio",
            "publicKeyPem": identity.public_key_pem,
        }),
        None,
    )
    .await?;
    let id = result
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "session.register did not return sessionId".to_string())?
        .to_string();
    let _ = STUDIO_AGENT_ID.set(id.clone());
    Ok(id)
}

/// Register a local inference agent (Ubuntu Inference Snap or Ollama) as a
/// daemon session under a daemon-minted identity. Returns the one-shot
/// private key so the caller can sign `session.end` later.
///
/// This is the Studio counterpart to Claude/Grok hook identity (INIT-002 Phase 1):
/// every daily-driver agent harness — frontier hooks **and** local snaps — is a
/// governed session on the same daemon, not a free-floating process.
pub async fn register_inference_agent(
    agent_id: &str,
    agent_name: &str,
    backend: &str,
    work_dir: &str,
) -> Result<InferenceAgentCreds, String> {
    let result = rpc_call_raw(
        "session.register",
        serde_json::json!({
            "agentId": agent_id,
            "agentName": agent_name,
            "workDir": work_dir,
            "backend": backend,
        }),
        None,
    )
    .await?;
    let did = result
        .get("did")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "session.register did not return did".to_string())?
        .to_string();
    // One-shot private key only on first mint; re-spawn of same agentId may omit it.
    let private_key_pem = result
        .get("privateKeyPem")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Ok(InferenceAgentCreds {
        agent_id: agent_id.to_string(),
        did,
        private_key_pem,
    })
}

/// Creds for a local inference agent session registered with the daemon.
#[derive(Clone)]
pub struct InferenceAgentCreds {
    pub agent_id: String,
    pub did: String,
    /// Present only on first mint for this agentId.
    pub private_key_pem: Option<String>,
}

/// End a local inference agent session with a verified signature when the
/// one-shot private key is available; otherwise best-effort unsigned (prune
/// still reaps). Prefer signed end for clean coordination state.
pub async fn end_inference_agent(creds: &InferenceAgentCreds) -> Result<(), String> {
    let params = serde_json::json!({
        "exitSummary": format!("inference-agent-stop:{}", creds.agent_id),
    });
    let signature = match &creds.private_key_pem {
        Some(pem) => {
            let identity = signing::EphemeralAgentIdentity::from_daemon_mint(&creds.did, pem)?;
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| format!("system clock before epoch: {e}"))?
                .as_secs() as i64;
            Some(identity.sign_request("session.end", &params, ts))
        }
        None => None,
    };
    match rpc_call_raw("session.end", params, signature).await {
        Ok(_) => Ok(()),
        Err(e) if e.contains("-32003") || e.contains("signed request") => {
            // Unsigned end is expected when re-spawn had no private key re-emit.
            Err(e)
        }
        Err(e) => Err(e),
    }
}

/// Send a JSON-RPC request to the daemon, automatically injecting the cached
/// Studio agent ID as `actorAgentId` so the daemon can attribute the call.
///
/// Each call opens a fresh connection (the daemon handles concurrent sockets).
pub async fn rpc_call(
    method: &str,
    mut params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // ping and session.register don't need identity
    let exempt = matches!(method, "ping" | "session.register" | "inference.status");
    let mut signature: Option<String> = None;
    if !exempt {
        let agent_id = ensure_session().await?;
        if let Some(obj) = params.as_object_mut() {
            obj.entry("actorAgentId")
                .or_insert(serde_json::Value::String(agent_id));
        }
        // Sign mutations + content reads. The signature covers the FINAL params
        // (after actorAgentId injection), since the daemon recomputes paramsHash
        // over exactly what it receives.
        if signing::requires_signature(method) {
            let identity = studio_identity().await?;
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| format!("system clock before epoch: {e}"))?
                .as_secs() as i64;
            signature = Some(identity.sign_request(method, &params, ts));
        }
    }
    rpc_call_raw(method, params, signature).await
}

/// Project roots already registered with the daemon this session, so we skip a
/// redundant `project.open` round-trip per call. Self-heals on daemon restart:
/// a "not registered" error clears the entry and `repo_rpc` re-opens + retries.
static OPENED_PROJECTS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Ensure `repo_path` is registered as a daemon project root (idempotent). The
/// daemon's file.* / git.* handlers reject any repo that hasn't been opened —
/// it is the allowlist that confines file access to known roots.
async fn ensure_project_open(repo_path: &str) -> Result<(), String> {
    if OPENED_PROJECTS.lock().unwrap().contains(repo_path) {
        return Ok(());
    }
    rpc_call("project.open", serde_json::json!({ "repoPath": repo_path })).await?;
    OPENED_PROJECTS
        .lock()
        .unwrap()
        .insert(repo_path.to_string());
    Ok(())
}

/// Call a repo-scoped file.* / git.* method: register the root (cached), inject
/// `repoPath`, dispatch, and — if the daemon was restarted and forgot the root
/// — re-open and retry once.
pub async fn repo_rpc(
    method: &str,
    repo_path: &str,
    mut params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if let Some(obj) = params.as_object_mut() {
        obj.insert(
            "repoPath".to_string(),
            serde_json::Value::String(repo_path.to_string()),
        );
    }
    ensure_project_open(repo_path).await?;
    match rpc_call(method, params.clone()).await {
        Err(e) if e.contains("not registered") => {
            OPENED_PROJECTS.lock().unwrap().remove(repo_path);
            ensure_project_open(repo_path).await?;
            rpc_call(method, params).await
        }
        other => other,
    }
}

#[cfg(unix)]
async fn rpc_call_raw(
    method: &str,
    params: serde_json::Value,
    signature: Option<String>,
) -> Result<serde_json::Value, String> {
    let path = socket_path();
    let mut last_err = String::new();

    for attempt in 0..MAX_RETRIES {
        match timeout(
            RPC_TIMEOUT,
            rpc_call_once(&path, method, &params, &signature),
        )
        .await
        {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(err)) => {
                // Parse failures and RPC-level errors are permanent — don't retry
                if err.starts_with("Parse failed:") || !is_transient_error(&err) {
                    return Err(err);
                }
                last_err = err;
            }
            Err(_) => {
                last_err = format!("RPC timeout after {}s: {method}", RPC_TIMEOUT.as_secs());
            }
        }

        // Backoff before next attempt (skip after final attempt)
        if attempt < MAX_RETRIES - 1 {
            tokio::time::sleep(Duration::from_millis(RETRY_DELAYS_MS[attempt])).await;
        }
    }

    Err(last_err)
}

/// Returns true if the error string indicates a transient failure worth retrying.
#[cfg(unix)]
fn is_transient_error(err: &str) -> bool {
    err.starts_with("Harness daemon not running:")
        || err.starts_with("Write failed:")
        || err.starts_with("Read failed:")
        || err.starts_with("RPC timeout")
}

/// Execute a single RPC call over a fresh Unix socket connection.
#[cfg(unix)]
async fn rpc_call_once(
    path: &str,
    method: &str,
    params: &serde_json::Value,
    signature: &Option<String>,
) -> Result<serde_json::Value, String> {
    let stream = UnixStream::connect(path)
        .await
        .map_err(|e| format!("Harness daemon not running: {e}"))?;
    let (reader, mut writer) = stream.into_split();

    let id = REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let request = JsonRpcRequest {
        jsonrpc: "2.0",
        id,
        method,
        params: params.clone(),
        signature: signature.clone(),
    };

    let mut payload = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    payload.push(b'\n');
    writer
        .write_all(&payload)
        .await
        .map_err(|e| format!("Write failed: {e}"))?;

    let mut buf_reader = BufReader::new(reader);
    let mut line = String::new();
    buf_reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("Read failed: {e}"))?;

    let response: JsonRpcResponse =
        serde_json::from_str(&line).map_err(|e| format!("Parse failed: {e}"))?;

    if let Some(error) = response.error {
        return Err(error.message);
    }

    Ok(response.result.unwrap_or(serde_json::Value::Null))
}

// ---------------------------------------------------------------------------
// Windows transport — the daemon runs inside WSL on ext4, so Studio reaches its
// AF_UNIX socket through a `wsl.exe`-launched `revdev-relay` child that pumps
// bytes between the socket and its own stdin/stdout (ADR P1). No Windows
// process ever touches ext4 or the 9P redirector. Signing is transport-
// agnostic and already applied in `rpc_call`, so only the connection mechanism
// differs from the Unix path; the retry/timeout policy is identical.
//
// Per-call model: one relay child per request (mirrors the Unix fresh-
// `UnixStream`-per-call), reaped via kill_on_drop. A long-lived multiplexed
// relay is a possible future optimization if spawn cost becomes material.
// ---------------------------------------------------------------------------

/// Distro hosting the WSL daemon. Overridable for non-default installs.
#[cfg(not(unix))]
fn wsl_distro() -> String {
    std::env::var("REVDEV_WSL_DISTRO").unwrap_or_else(|_| "Ubuntu".to_string())
}

#[cfg(not(unix))]
const RELAY_DOWN_COOLDOWN: Duration = Duration::from_secs(20);

#[cfg(not(unix))]
static RELAY_COOLDOWN_UNTIL: std::sync::Mutex<Option<std::time::Instant>> =
    std::sync::Mutex::new(None);

#[cfg(not(unix))]
struct LiveRelay {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: tokio::io::BufReader<tokio::process::ChildStdout>,
}

#[cfg(not(unix))]
impl Drop for LiveRelay {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

#[cfg(not(unix))]
static LIVE_RELAY: tokio::sync::Mutex<Option<LiveRelay>> = tokio::sync::Mutex::const_new(None);

#[cfg(not(unix))]
fn mark_relay_down() {
    if let Ok(mut guard) = RELAY_COOLDOWN_UNTIL.lock() {
        *guard = Some(std::time::Instant::now() + RELAY_DOWN_COOLDOWN);
    }
}

#[cfg(not(unix))]
fn relay_is_cooling_down() -> bool {
    let until = RELAY_COOLDOWN_UNTIL.lock().ok().and_then(|g| *g);
    relay_spawn_on_cooldown(std::time::Instant::now(), until)
}

#[cfg(not(unix))]
async fn rpc_call_raw(
    method: &str,
    params: serde_json::Value,
    signature: Option<String>,
) -> Result<serde_json::Value, String> {
    if relay_is_cooling_down() {
        return Err(relay_closed_message(""));
    }

    let mut last_err = String::new();

    for attempt in 0..MAX_RETRIES {
        match timeout(RPC_TIMEOUT, rpc_call_once(method, &params, &signature)).await {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(err)) => {
                if err.starts_with("Parse failed:") || !is_transient_error(&err) {
                    return Err(err);
                }
                last_err = err;
            }
            Err(_) => {
                last_err = format!("RPC timeout after {}s: {method}", RPC_TIMEOUT.as_secs());
            }
        }

        if attempt < MAX_RETRIES - 1 {
            tokio::time::sleep(Duration::from_millis(RETRY_DELAYS_MS[attempt])).await;
        }
    }

    if last_err.starts_with("Relay closed") || last_err.starts_with("Relay spawn failed:") {
        mark_relay_down();
    }
    Err(last_err)
}

/// Transient = worth respawning the relay + retrying. Spawn failure, a broken
/// pipe to the child, or an EOF before any response all mean the relay/daemon
/// went away mid-flight; the next attempt spawns a fresh relay.
#[cfg(not(unix))]
fn is_transient_error(err: &str) -> bool {
    err.starts_with("Relay spawn failed:")
        || err.starts_with("Write failed:")
        || err.starts_with("Read failed:")
        || err.starts_with("Relay closed without response")
        || err.starts_with("RPC timeout")
}

#[cfg(not(unix))]
async fn spawn_live_relay() -> Result<LiveRelay, String> {
    use tokio::io::BufReader;
    use tokio::process::Command;

    // `--shell-type none` + `bash -c` (not `-lc`) so WSL does not open a
    // login console. `$HOME` is still set. CREATE_NO_WINDOW is applied by
    // hide_tokio. One child is reused for every RPC on this process.
    let relay_cmd = format!(r#"exec "$HOME/.local/bin/revdev-relay" "$HOME/{SOCKET_REL_PATH}""#);
    let mut relay = Command::new("wsl.exe");
    crate::win_process::hide_tokio(&mut relay);
    let mut child = relay
        .args([
            "-d",
            &wsl_distro(),
            "--shell-type",
            "none",
            "-e",
            "bash",
            "-c",
            &relay_cmd,
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(false)
        .spawn()
        .map_err(|e| format!("Relay spawn failed: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Relay spawn failed: stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Relay spawn failed: stdout unavailable".to_string())?;
    Ok(LiveRelay {
        child,
        stdin,
        stdout: BufReader::new(stdout),
    })
}

/// Execute one RPC on the long-lived WSL relay. The daemon already accepts
/// many newline-framed requests on one Unix socket; we keep stdin open so
/// the relay child stays up across Agent/git/workboard/watcher calls.
#[cfg(not(unix))]
async fn rpc_call_once(
    method: &str,
    params: &serde_json::Value,
    signature: &Option<String>,
) -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    let mut slot = LIVE_RELAY.lock().await;
    if slot.is_none() {
        *slot = Some(spawn_live_relay().await.map_err(|e| {
            mark_relay_down();
            e
        })?);
    }

    let id = REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let request = JsonRpcRequest {
        jsonrpc: "2.0",
        id,
        method,
        params: params.clone(),
        signature: signature.clone(),
    };
    let mut payload = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    payload.push(b'\n');

    let write_err = {
        let relay = slot.as_mut().expect("relay just inserted");
        relay
            .stdin
            .write_all(&payload)
            .await
            .err()
            .map(|e| format!("Write failed: {e}"))
    };
    if let Some(err) = write_err {
        *slot = None;
        return Err(err);
    }
    if let Some(relay) = slot.as_mut() {
        if let Err(e) = relay.stdin.flush().await {
            *slot = None;
            return Err(format!("Write failed: {e}"));
        }
    }

    let mut line = String::new();
    let n = {
        let relay = slot.as_mut().expect("relay still held");
        relay
            .stdout
            .read_line(&mut line)
            .await
            .map_err(|e| format!("Read failed: {e}"))
    };
    let n = match n {
        Ok(n) => n,
        Err(err) => {
            *slot = None;
            return Err(err);
        }
    };
    if n == 0 {
        let mut err_buf = String::new();
        if let Some(mut relay) = slot.take() {
            if let Some(stderr) = relay.child.stderr.take() {
                let mut err_reader = tokio::io::BufReader::new(stderr);
                let _ = timeout(
                    Duration::from_millis(250),
                    tokio::io::AsyncReadExt::read_to_string(&mut err_reader, &mut err_buf),
                )
                .await;
            }
        }
        mark_relay_down();
        return Err(relay_closed_message(&err_buf));
    }

    let response: JsonRpcResponse =
        serde_json::from_str(&line).map_err(|e| format!("Parse failed: {e}"))?;

    if let Some(error) = response.error {
        return Err(error.message);
    }
    Ok(response.result.unwrap_or(serde_json::Value::Null))
}

#[cfg(test)]
mod relay_closed_tests {
    use super::{relay_closed_message, relay_spawn_on_cooldown};

    #[test]
    fn empty_stderr_points_at_setup() {
        let msg = relay_closed_message("  ");
        assert!(msg.starts_with("Relay closed without response"));
        assert!(msg.contains("Open Setup from the sidebar"));
        assert!(!msg.contains('('));
    }

    #[test]
    fn includes_relay_stderr_hint() {
        let msg = relay_closed_message(
            "revdev-relay: connect /home/x/.local/share/revealui/harness.sock: No such file or directory\n",
        );
        assert!(msg.starts_with("Relay closed without response"));
        assert!(msg.contains("No such file or directory"));
    }

    #[test]
    fn cooldown_skips_spawn_until_deadline() {
        let start = std::time::Instant::now();
        let until = Some(start + std::time::Duration::from_secs(20));
        assert!(relay_spawn_on_cooldown(start, until));
        assert!(!relay_spawn_on_cooldown(
            start + std::time::Duration::from_secs(21),
            until
        ));
        assert!(!relay_spawn_on_cooldown(start, None));
    }
}
