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
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::sync::OnceCell;
use tokio::time::{timeout, Duration};

const SOCKET_REL_PATH: &str = ".local/share/revealui/harness.sock";

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
async fn rpc_call_raw(
    method: &str,
    params: serde_json::Value,
    signature: Option<String>,
) -> Result<serde_json::Value, String> {
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

/// Execute a single RPC over a freshly-spawned relay child.
#[cfg(not(unix))]
async fn rpc_call_once(
    method: &str,
    params: &serde_json::Value,
    signature: &Option<String>,
) -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::process::Command;

    // The socket path is resolved WSL-side against the daemon's $HOME so Studio
    // never needs to know the WSL username; `exec` hands stdio straight to the
    // relay. A login shell (`-lc`) ensures $HOME is set.
    let relay_cmd = format!(r#"exec "$HOME/.local/bin/revdev-relay" "$HOME/{SOCKET_REL_PATH}""#);
    let mut child = Command::new("wsl.exe")
        .args(["-d", &wsl_distro(), "-e", "bash", "-lc", &relay_cmd])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Relay spawn failed: {e}"))?;

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

    // Write the request, then close stdin so the relay half-closes the socket
    // write side — the daemon has the complete (newline-framed) request and can
    // respond. The response comes back over the child's stdout.
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Relay spawn failed: stdin unavailable".to_string())?;
        stdin
            .write_all(&payload)
            .await
            .map_err(|e| format!("Write failed: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Write failed: {e}"))?;
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Read failed: stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let n = reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("Read failed: {e}"))?;
    if n == 0 {
        // EOF before any response — relay or daemon died. Transient → respawn.
        return Err("Relay closed without response".to_string());
    }

    // child is killed + reaped on drop (kill_on_drop) at function exit.
    let response: JsonRpcResponse =
        serde_json::from_str(&line).map_err(|e| format!("Parse failed: {e}"))?;

    if let Some(error) = response.error {
        return Err(error.message);
    }
    Ok(response.result.unwrap_or(serde_json::Value::Null))
}
