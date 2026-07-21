//! Tauri commands for the RevDev Harness daemon.
//!
//! Each command delegates to [`crate::harness::rpc_call`] which speaks
//! JSON-RPC 2.0 over the daemon's Unix socket.

use super::error::StudioError;
use crate::harness;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ── Types mirroring the daemon's PGlite schema ─────────────────────────────

#[derive(Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HarnessSession {
    pub id: String,
    pub env: String,
    pub task: String,
    pub files: Option<String>,
    pub pid: Option<i64>,
    pub started_at: String,
    pub updated_at: String,
    pub ended_at: Option<String>,
    pub exit_summary: Option<String>,
    /// GAP-257 activity state when present (`active` | `blocked` | `idle`).
    #[serde(default)]
    pub activity_state: Option<String>,
    /// Why blocked (e.g. `permission`) when activity_state is blocked.
    #[serde(default)]
    pub blocked_reason: Option<String>,
    /// GAP-294 per-session permission mode override (null = daemon default).
    #[serde(default)]
    pub permission_mode: Option<String>,
}

/// Pending approval row from `permission.pending` (GAP-294).
#[derive(Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HarnessApproval {
    pub id: String,
    pub agent_id: String,
    pub method: String,
    pub params_hash: String,
    pub summary: String,
    pub requested_at: String,
    pub expires_at: String,
    pub status: String,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HarnessDecideResult {
    pub id: String,
    pub status: String,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HarnessSetModeResult {
    pub agent_id: String,
    pub permission_mode: Option<String>,
    pub daemon_default: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HarnessMessage {
    pub id: i64,
    pub from_agent: String,
    pub to_agent: String,
    pub subject: String,
    pub body: String,
    pub read: bool,
    pub created_at: String,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HarnessTask {
    pub id: String,
    pub description: String,
    pub status: String,
    pub owner: Option<String>,
    pub claimed_at: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HarnessReservation {
    pub file_path: String,
    pub agent_id: String,
    pub reserved_at: String,
    pub expires_at: String,
    pub reason: String,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HarnessClaimResult {
    pub success: bool,
    pub owner: Option<String>,
}

#[derive(Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HarnessReserveResult {
    pub success: bool,
    pub holder: Option<String>,
}

// ── Daemon health ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn harness_ping() -> Result<bool, StudioError> {
    match harness::rpc_call("ping", serde_json::json!({})).await {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

// ── Sessions ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn harness_sessions() -> Result<Vec<HarnessSession>, StudioError> {
    let result = harness::rpc_call("session.list", serde_json::json!({}))
        .await
        .map_err(|e| StudioError::Other(e))?;
    // Daemon returns { sessions: [...], scope, ... }; unwrap for the UI.
    let sessions = result.get("sessions").cloned().unwrap_or(result);
    // Map snake_case rows; tolerate extra columns (activity_state, permission_mode).
    let rows = sessions.as_array().cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        // Normalize camelCase aliases if present (fleet scope may differ).
        let mut obj = row.as_object().cloned().unwrap_or_default();
        if !obj.contains_key("started_at") {
            if let Some(v) = obj.remove("startedAt") {
                obj.insert("started_at".into(), v);
            }
        }
        if !obj.contains_key("updated_at") {
            if let Some(v) = obj.remove("updatedAt") {
                obj.insert("updated_at".into(), v);
            }
        }
        if !obj.contains_key("ended_at") {
            if let Some(v) = obj.remove("endedAt") {
                obj.insert("ended_at".into(), v);
            }
        }
        if !obj.contains_key("exit_summary") {
            if let Some(v) = obj.remove("exitSummary") {
                obj.insert("exit_summary".into(), v);
            }
        }
        if !obj.contains_key("activity_state") {
            if let Some(v) = obj.remove("activityState") {
                obj.insert("activity_state".into(), v);
            }
        }
        if !obj.contains_key("blocked_reason") {
            if let Some(v) = obj.remove("blockedReason") {
                obj.insert("blocked_reason".into(), v);
            }
        }
        if !obj.contains_key("permission_mode") {
            if let Some(v) = obj.remove("permissionMode") {
                obj.insert("permission_mode".into(), v);
            }
        }
        // Required string fields: coerce null task/env to empty.
        if obj.get("task").map(|v| v.is_null()).unwrap_or(true) {
            obj.insert("task".into(), serde_json::Value::String(String::new()));
        }
        if obj.get("env").map(|v| v.is_null()).unwrap_or(true) {
            obj.insert("env".into(), serde_json::Value::String(String::new()));
        }
        if obj.get("started_at").map(|v| v.is_null()).unwrap_or(true) {
            obj.insert(
                "started_at".into(),
                serde_json::Value::String(String::new()),
            );
        }
        if obj.get("updated_at").map(|v| v.is_null()).unwrap_or(true) {
            obj.insert(
                "updated_at".into(),
                serde_json::Value::String(String::new()),
            );
        }
        match serde_json::from_value::<HarnessSession>(serde_json::Value::Object(obj)) {
            Ok(s) => out.push(s),
            Err(_) => continue,
        }
    }
    Ok(out)
}

// ── Messages ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn harness_inbox(
    agent_id: String,
    unread_only: bool,
) -> Result<Vec<HarnessMessage>, StudioError> {
    let result = harness::rpc_call(
        "mail.inbox",
        serde_json::json!({ "agentId": agent_id, "unreadOnly": unread_only }),
    )
    .await
    .map_err(|e| StudioError::Other(e))?;
    // Daemon returns { messages: [...] }; unwrap for the UI.
    let messages = result.get("messages").cloned().unwrap_or(result);
    serde_json::from_value(messages).map_err(|e| StudioError::Other(e.to_string()))
}

#[tauri::command]
pub async fn harness_send_message(
    from_agent: String,
    to_agent: String,
    subject: String,
    body: String,
) -> Result<serde_json::Value, StudioError> {
    // `from_agent` is ignored — the daemon attributes the call to the
    // registered Studio session (via actorAgentId). Left in the signature
    // for frontend API compatibility.
    let _ = from_agent;
    let result = harness::rpc_call(
        "mail.send",
        serde_json::json!({
            "to": to_agent,
            "subject": subject,
            "body": body,
        }),
    )
    .await
    .map_err(|e| StudioError::Other(e))?;
    Ok(result)
}

#[tauri::command]
pub async fn harness_broadcast(
    from_agent: String,
    subject: String,
    body: String,
) -> Result<i64, StudioError> {
    let _ = from_agent;
    let result = harness::rpc_call(
        "mail.broadcast",
        serde_json::json!({
            "subject": subject,
            "body": body,
        }),
    )
    .await
    .map_err(|e| StudioError::Other(e))?;

    // Returns { sent: number, recipients: number, broadcast: true }
    Ok(parse_broadcast_sent(&result))
}

#[tauri::command]
pub async fn harness_mark_read(message_ids: Vec<i64>) -> Result<(), StudioError> {
    harness::rpc_call(
        "mail.markRead",
        serde_json::json!({ "messageIds": message_ids }),
    )
    .await
    .map_err(|e| StudioError::Other(e))?;
    Ok(())
}

// ── Pure parsers (testable without a daemon) ────────────────────────────────

/// Parse the response shape of `tasks.claim` into a typed struct.
/// Missing fields default to `{ success: false, owner: None }`.
fn parse_claim_result(val: &serde_json::Value) -> HarnessClaimResult {
    HarnessClaimResult {
        success: val.get("success").and_then(|v| v.as_bool()).unwrap_or(false),
        owner: val
            .get("owner")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    }
}

/// Parse the response shape of `files.reserve` into a typed struct.
/// The daemon returns `{ success, conflicts: [{ path, holder }] }` — we
/// surface the first conflict's holder to the UI.
fn parse_reserve_result(val: &serde_json::Value) -> HarnessReserveResult {
    let success = val.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
    let holder = val
        .get("conflicts")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|o| o.get("holder"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    HarnessReserveResult { success, holder }
}

/// Parse `mail.broadcast` → returns the count of recipients that received
/// the message. Missing or non-numeric `sent` defaults to 0.
fn parse_broadcast_sent(val: &serde_json::Value) -> i64 {
    val.get("sent").and_then(|v| v.as_i64()).unwrap_or(0)
}

/// Parse a success flag keyed at `ok` (used by `tasks.complete` /
/// `tasks.release`). Missing or non-bool defaults to false.
fn parse_ok_flag(val: &serde_json::Value) -> bool {
    val.get("ok").and_then(|v| v.as_bool()).unwrap_or(false)
}

// ── Tasks ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn harness_tasks(
    status: Option<String>,
    owner: Option<String>,
) -> Result<Vec<HarnessTask>, StudioError> {
    let mut params = serde_json::Map::new();
    if let Some(s) = status {
        params.insert("status".into(), serde_json::Value::String(s));
    }
    if let Some(o) = owner {
        params.insert("owner".into(), serde_json::Value::String(o));
    }
    let result = harness::rpc_call("tasks.list", serde_json::Value::Object(params))
        .await
        .map_err(|e| StudioError::Other(e))?;
    let tasks = result.get("tasks").cloned().unwrap_or(result);
    serde_json::from_value(tasks).map_err(|e| StudioError::Other(e.to_string()))
}

#[tauri::command]
pub async fn harness_create_task(
    task_id: String,
    description: String,
) -> Result<serde_json::Value, StudioError> {
    let result = harness::rpc_call(
        "tasks.create",
        serde_json::json!({
            "taskId": task_id,
            "title": description.clone(),
            "description": description,
        }),
    )
    .await
    .map_err(|e| StudioError::Other(e))?;
    Ok(result)
}

// Note: agent_id kept in the frontend signature but no longer forwarded —
// the daemon uses the registered Studio session (actorAgentId) as the owner.
#[tauri::command]
pub async fn harness_claim_task(
    task_id: String,
    agent_id: String,
) -> Result<HarnessClaimResult, StudioError> {
    let _ = agent_id;
    let result = harness::rpc_call(
        "tasks.claim",
        serde_json::json!({ "taskId": task_id }),
    )
    .await
    .map_err(|e| StudioError::Other(e))?;
    Ok(parse_claim_result(&result))
}

#[tauri::command]
pub async fn harness_complete_task(
    task_id: String,
    agent_id: String,
) -> Result<bool, StudioError> {
    let _ = agent_id;
    let result = harness::rpc_call(
        "tasks.complete",
        serde_json::json!({ "taskId": task_id }),
    )
    .await
    .map_err(|e| StudioError::Other(e))?;
    Ok(parse_ok_flag(&result))
}

#[tauri::command]
pub async fn harness_release_task(
    task_id: String,
    agent_id: String,
) -> Result<bool, StudioError> {
    let _ = agent_id;
    let result = harness::rpc_call(
        "tasks.release",
        serde_json::json!({ "taskId": task_id }),
    )
    .await
    .map_err(|e| StudioError::Other(e))?;
    Ok(parse_ok_flag(&result))
}

// ── File Reservations ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn harness_reservations(
    agent_id: Option<String>,
) -> Result<Vec<HarnessReservation>, StudioError> {
    let params = match agent_id {
        Some(id) => serde_json::json!({ "agentId": id }),
        None => serde_json::json!({}),
    };
    let result = harness::rpc_call("files.list", params)
        .await
        .map_err(|e| StudioError::Other(e))?;
    let reservations = result.get("reservations").cloned().unwrap_or(result);
    serde_json::from_value(reservations).map_err(|e| StudioError::Other(e.to_string()))
}

#[tauri::command]
pub async fn harness_reserve_file(
    file_path: String,
    agent_id: String,
    ttl_seconds: u32,
    reason: String,
) -> Result<HarnessReserveResult, StudioError> {
    // agent_id ignored — daemon uses the registered Studio session.
    let _ = agent_id;
    let result = harness::rpc_call(
        "files.reserve",
        serde_json::json!({
            "paths": [file_path],
            "ttlSeconds": ttl_seconds,
            "reason": reason,
        }),
    )
    .await
    .map_err(|e| StudioError::Other(e))?;

    Ok(parse_reserve_result(&result))
}

#[tauri::command]
pub async fn harness_check_file(
    file_path: String,
) -> Result<Option<HarnessReservation>, StudioError> {
    let result = harness::rpc_call(
        "files.check",
        serde_json::json!({ "paths": [file_path] }),
    )
    .await
    .map_err(|e| StudioError::Other(e))?;
    let rows = result
        .get("reservations")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    match rows.into_iter().next() {
        None => Ok(None),
        Some(row) => serde_json::from_value(row)
            .map(Some)
            .map_err(|e| StudioError::Other(e.to_string())),
    }
}

// ── Permissions (GAP-294 Phase 2) ───────────────────────────────────────────

#[tauri::command]
pub async fn harness_permission_pending(
    agent_id: Option<String>,
) -> Result<Vec<HarnessApproval>, StudioError> {
    let mut params = serde_json::Map::new();
    if let Some(id) = agent_id {
        if !id.is_empty() {
            params.insert("agentId".into(), serde_json::Value::String(id));
        }
    }
    let result = harness::rpc_call("permission.pending", serde_json::Value::Object(params))
        .await
        .map_err(|e| StudioError::Other(e))?;
    let approvals = result.get("approvals").cloned().unwrap_or(result);
    let rows = approvals.as_array().cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut obj = row.as_object().cloned().unwrap_or_default();
        // Daemon returns camelCase (agentId, paramsHash, …); Rust type uses snake.
        for (from, to) in [
            ("agentId", "agent_id"),
            ("paramsHash", "params_hash"),
            ("requestedAt", "requested_at"),
            ("expiresAt", "expires_at"),
        ] {
            if !obj.contains_key(to) {
                if let Some(v) = obj.remove(from) {
                    obj.insert(to.into(), v);
                }
            }
        }
        if let Ok(a) = serde_json::from_value::<HarnessApproval>(serde_json::Value::Object(obj)) {
            out.push(a);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn harness_permission_decide(
    approval_id: String,
    verdict: String,
) -> Result<HarnessDecideResult, StudioError> {
    let result = harness::rpc_call(
        "permission.decide",
        serde_json::json!({ "approvalId": approval_id, "verdict": verdict }),
    )
    .await
    .map_err(|e| StudioError::Other(e))?;
    // Daemon: { id, status }
    let id = result
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or(&approval_id)
        .to_string();
    let status = result
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(HarnessDecideResult { id, status })
}

#[tauri::command]
pub async fn harness_permission_set_mode(
    agent_id: String,
    mode: Option<String>,
) -> Result<HarnessSetModeResult, StudioError> {
    let result = harness::rpc_call(
        "permission.setMode",
        serde_json::json!({ "agentId": agent_id, "mode": mode }),
    )
    .await
    .map_err(|e| StudioError::Other(e))?;
    let agent = result
        .get("agentId")
        .and_then(|v| v.as_str())
        .unwrap_or(&agent_id)
        .to_string();
    let permission_mode = result
        .get("permissionMode")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let daemon_default = result
        .get("daemonDefault")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(HarnessSetModeResult {
        agent_id: agent,
        permission_mode,
        daemon_default,
    })
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // parse_claim_result ------------------------------------------------------

    #[test]
    fn parse_claim_result_missing_fields_defaults_to_false_and_none() {
        let r = parse_claim_result(&json!({}));
        assert!(!r.success);
        assert!(r.owner.is_none());
    }

    #[test]
    fn parse_claim_result_extracts_success_and_owner() {
        let r = parse_claim_result(&json!({
            "success": true,
            "owner": "agent-alice",
        }));
        assert!(r.success);
        assert_eq!(r.owner.as_deref(), Some("agent-alice"));
    }

    #[test]
    fn parse_claim_result_ignores_non_string_owner() {
        // Daemon contract says owner is a string; a numeric value should fall
        // back to None rather than panic or stringify the number.
        let r = parse_claim_result(&json!({
            "success": false,
            "owner": 42,
        }));
        assert!(!r.success);
        assert!(r.owner.is_none());
    }

    // parse_reserve_result ----------------------------------------------------

    #[test]
    fn parse_reserve_result_no_conflicts_yields_none_holder() {
        let r = parse_reserve_result(&json!({
            "success": true,
            "conflicts": [],
        }));
        assert!(r.success);
        assert!(r.holder.is_none());
    }

    #[test]
    fn parse_reserve_result_extracts_first_conflict_holder() {
        let r = parse_reserve_result(&json!({
            "success": false,
            "conflicts": [
                { "path": "/x.ts", "holder": "agent-alice" },
                { "path": "/y.ts", "holder": "agent-bob" },
            ],
        }));
        assert!(!r.success);
        assert_eq!(r.holder.as_deref(), Some("agent-alice"));
    }

    #[test]
    fn parse_reserve_result_missing_fields_defaults_cleanly() {
        let r = parse_reserve_result(&json!({}));
        assert!(!r.success);
        assert!(r.holder.is_none());
    }

    // parse_broadcast_sent ----------------------------------------------------

    #[test]
    fn parse_broadcast_sent_missing_is_zero() {
        assert_eq!(parse_broadcast_sent(&json!({})), 0);
    }

    #[test]
    fn parse_broadcast_sent_reads_integer() {
        assert_eq!(parse_broadcast_sent(&json!({ "sent": 7 })), 7);
    }

    #[test]
    fn parse_broadcast_sent_ignores_non_integer() {
        // String or null should not crash — contract violation → 0.
        assert_eq!(parse_broadcast_sent(&json!({ "sent": "seven" })), 0);
        assert_eq!(parse_broadcast_sent(&json!({ "sent": null })), 0);
    }

    // parse_ok_flag -----------------------------------------------------------

    #[test]
    fn parse_ok_flag_missing_is_false() {
        assert!(!parse_ok_flag(&json!({})));
    }

    #[test]
    fn parse_ok_flag_reads_true_and_false() {
        assert!(parse_ok_flag(&json!({ "ok": true })));
        assert!(!parse_ok_flag(&json!({ "ok": false })));
    }

    #[test]
    fn parse_ok_flag_ignores_non_bool() {
        assert!(!parse_ok_flag(&json!({ "ok": 1 })));
        assert!(!parse_ok_flag(&json!({ "ok": "true" })));
    }

    // Serde round-trip for wire types ----------------------------------------

    #[test]
    fn harness_session_serde_roundtrip() {
        let s = HarnessSession {
            id: "s1".into(),
            env: "claude:alice".into(),
            task: "ship feature".into(),
            files: Some("src/a.ts".into()),
            pid: Some(12345),
            started_at: "2026-04-18T00:00:00Z".into(),
            updated_at: "2026-04-18T00:05:00Z".into(),
            ended_at: None,
            exit_summary: None,
            activity_state: Some("blocked".into()),
            blocked_reason: Some("permission".into()),
            permission_mode: Some("manual".into()),
        };
        let wire = serde_json::to_value(&s).unwrap();
        let back: HarnessSession = serde_json::from_value(wire).unwrap();
        assert_eq!(back.id, s.id);
        assert_eq!(back.env, s.env);
        assert_eq!(back.task, s.task);
        assert_eq!(back.pid, s.pid);
        assert_eq!(back.ended_at, s.ended_at);
    }

    #[test]
    fn harness_task_serde_roundtrip() {
        let t = HarnessTask {
            id: "t1".into(),
            description: "do the thing".into(),
            status: "open".into(),
            owner: None,
            claimed_at: None,
            completed_at: None,
            created_at: "2026-04-18T00:00:00Z".into(),
        };
        let wire = serde_json::to_value(&t).unwrap();
        let back: HarnessTask = serde_json::from_value(wire).unwrap();
        assert_eq!(back.id, t.id);
        assert_eq!(back.status, t.status);
        assert_eq!(back.owner, t.owner);
    }
}
