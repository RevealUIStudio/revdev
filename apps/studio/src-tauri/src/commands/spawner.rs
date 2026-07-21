use tauri::State;

use super::error::StudioError;
use crate::spawner::{backend_daemon_label, AgentBackend, SpawnerState};

/// Spawn a new agent process using local inference (Ubuntu Inference Snap or Ollama).
///
/// Also registers a daemon-minted session (INIT-002 Phase 1) so Snap/Ollama
/// agents appear in coordination as governed users — same identity model as
/// Claude/Grok hooks, not a free-floating local process.
#[tauri::command]
pub async fn agent_spawn(
    name: String,
    backend: AgentBackend,
    model: String,
    prompt: String,
    app_handle: tauri::AppHandle,
    state: State<'_, SpawnerState>,
) -> Result<String, StudioError> {
    let session_id = crate::spawner::spawn(
        name.clone(),
        backend.clone(),
        model.clone(),
        prompt,
        app_handle,
        state.sessions.clone(),
    )
    .map_err(StudioError::Process)?;

    // Best-effort daemon registration — process is already running.
    let backend_label = backend_daemon_label(&backend);
    let work_dir = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let agent_name = if name.is_empty() {
        format!("{backend_label}:{model}")
    } else {
        name
    };
    // agentId must be DID-safe: use snap- prefix + shortened uuid (hyphens ok).
    let daemon_agent_id = format!("snap-{}", session_id.replace('-', "").get(..24).unwrap_or(&session_id));

    match crate::harness::register_inference_agent(
        &daemon_agent_id,
        &agent_name,
        backend_label,
        &work_dir,
    )
    .await
    {
        Ok(creds) => {
            let _ = crate::spawner::set_daemon_creds(
                &session_id,
                state.sessions.clone(),
                creds,
            );
        }
        Err(e) => {
            // Non-fatal: local inference still works; coordination is degraded.
            eprintln!("[revdev] inference agent daemon register failed: {e}");
        }
    }

    Ok(session_id)
}

/// Stop a running agent process and end its daemon session when registered.
#[tauri::command]
pub async fn agent_stop(
    session_id: String,
    state: State<'_, SpawnerState>,
) -> Result<(), StudioError> {
    let creds = crate::spawner::take_daemon_creds(&session_id, state.sessions.clone());
    crate::spawner::stop(&session_id, state.sessions.clone()).map_err(StudioError::Process)?;
    if let Some(creds) = creds {
        if let Err(e) = crate::harness::end_inference_agent(&creds).await {
            eprintln!("[revdev] inference agent session.end failed: {e}");
        }
    }
    Ok(())
}

/// List all agent sessions.
#[tauri::command]
pub fn agent_list(
    state: State<'_, SpawnerState>,
) -> Result<Vec<crate::spawner::AgentSessionInfo>, StudioError> {
    crate::spawner::list(state.sessions.clone()).map_err(StudioError::Process)
}

/// Remove a stopped/errored agent session.
#[tauri::command]
pub async fn agent_remove(
    session_id: String,
    state: State<'_, SpawnerState>,
) -> Result<(), StudioError> {
    let creds = crate::spawner::take_daemon_creds(&session_id, state.sessions.clone());
    crate::spawner::remove(&session_id, state.sessions.clone()).map_err(StudioError::Process)?;
    if let Some(creds) = creds {
        if let Err(e) = crate::harness::end_inference_agent(&creds).await {
            eprintln!("[revdev] inference agent session.end failed: {e}");
        }
    }
    Ok(())
}

/// Write input data to a daemon PTY session (agent.input RPC).
#[tauri::command]
pub async fn agent_input(session_id: String, data: String) -> Result<(), StudioError> {
    crate::harness::rpc_call(
        "agent.input",
        serde_json::json!({ "sessionId": session_id, "data": data }),
    )
    .await
    .map_err(StudioError::Other)?;
    Ok(())
}

/// Resize a daemon PTY session's terminal (agent.resize RPC).
#[tauri::command]
pub async fn agent_resize(
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), StudioError> {
    crate::harness::rpc_call(
        "agent.resize",
        serde_json::json!({ "sessionId": session_id, "cols": cols, "rows": rows }),
    )
    .await
    .map_err(StudioError::Other)?;
    Ok(())
}
