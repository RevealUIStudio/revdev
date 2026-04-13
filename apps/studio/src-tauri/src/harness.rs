//! JSON-RPC 2.0 client for the RevDev Harness daemon.
//!
//! Connects to the daemon's Unix domain socket at
//! `~/.local/share/revealui/harness.sock` and sends newline-delimited
//! JSON-RPC requests.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::OnceCell;

const SOCKET_REL_PATH: &str = ".local/share/revealui/harness.sock";

fn socket_path() -> String {
    if let Some(home) = dirs::home_dir() {
        format!("{}/{}", home.display(), SOCKET_REL_PATH)
    } else {
        format!("/tmp/revealui-harness.sock")
    }
}

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
struct JsonRpcRequest<'a> {
    jsonrpc: &'static str,
    id: u64,
    method: &'a str,
    params: serde_json::Value,
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

/// Register this Studio instance as a daemon session (idempotent).
///
/// Studio opens a fresh socket per RPC call, so we can't rely on per-socket
/// identity surviving across calls. Instead we register once, cache the
/// returned agent ID, and pass it as `actorAgentId` on every coordination call.
pub async fn ensure_session() -> Result<String, String> {
    if let Some(id) = STUDIO_AGENT_ID.get() {
        return Ok(id.clone());
    }
    let result = rpc_call_raw(
        "session.register",
        serde_json::json!({
            "agentName": "studio-ui",
            "workDir": std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            "backend": "studio",
        }),
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
    if !exempt {
        let agent_id = ensure_session().await?;
        if let Some(obj) = params.as_object_mut() {
            obj.entry("actorAgentId")
                .or_insert(serde_json::Value::String(agent_id));
        }
    }
    rpc_call_raw(method, params).await
}

async fn rpc_call_raw(
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let path = socket_path();
    let stream = UnixStream::connect(&path)
        .await
        .map_err(|e| format!("Harness daemon not running: {e}"))?;
    let (reader, mut writer) = stream.into_split();

    let id = REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let request = JsonRpcRequest {
        jsonrpc: "2.0",
        id,
        method,
        params,
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
