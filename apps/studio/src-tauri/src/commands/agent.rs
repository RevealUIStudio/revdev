use serde_json::{json, Value};

/// Read a text file (e.g. the agent panel's workboard.md) through the WSL-side
/// daemon — zero-9P (ADR P2), so no Windows process reads ext4 directly.
///
/// The daemon's `file.read` is repo-scoped, so the file's directory is
/// registered as a project root and the basename is read within it. Paths are
/// passed verbatim; the daemon expands `~` against its own (WSL) `$HOME`.
#[tauri::command]
pub async fn agent_read_workboard(path: String) -> Result<String, String> {
    let (dir, file) = match path.rfind('/') {
        Some(i) => (path[..i].to_string(), path[i + 1..].to_string()),
        None => (".".to_string(), path.clone()),
    };
    let v: Value = crate::harness::repo_rpc("file.read", &dir, json!({ "filePath": file })).await?;
    if v.get("tooLarge").and_then(Value::as_bool) == Some(true) {
        return Err(format!("'{path}' is too large to open inline"));
    }
    v.get("content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("Cannot read '{path}'"))
}
