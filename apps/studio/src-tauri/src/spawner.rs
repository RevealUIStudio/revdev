use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use ts_rs::TS;

// ── Event payloads ──────────────────────────────────────────────────

/// Streamed output from an agent process (stdout or stderr).
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct AgentOutputEvent {
    pub session_id: String,
    pub stream: String, // "stdout" | "stderr"
    pub line: String,
}

/// Emitted when an agent process exits.
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct AgentExitEvent {
    pub session_id: String,
    pub code: Option<i32>,
}

/// Backend for the agent — which inference engine to use.
#[derive(Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "bindings/")]
pub enum AgentBackend {
    /// Ubuntu Inference Snap (recommended — one command install)
    Snap,
    /// Ollama local inference (any supported model)
    Ollama,
}

/// Serializable snapshot of one agent session.
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct AgentSessionInfo {
    pub id: String,
    pub name: String,
    pub model: String,
    pub backend: AgentBackend,
    pub prompt: String,
    pub status: String, // "running" | "stopped" | "errored"
    pub pid: Option<u32>,
}

// ── State ───────────────────────────────────────────────────────────

pub struct AgentProcess {
    pub name: String,
    pub model: String,
    pub backend: AgentBackend,
    pub prompt: String,
    pub child: Child,
    pub status: String,
}

/// Managed Tauri state for spawned agent sessions.
pub struct SpawnerState {
    pub sessions: Arc<Mutex<HashMap<String, AgentProcess>>>,
}

impl Default for SpawnerState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ── Core logic ──────────────────────────────────────────────────────

/// Spawn an agent process using local inference (Snap or Ollama).
/// Returns the session ID.
pub fn spawn(
    name: String,
    backend: AgentBackend,
    model: String,
    prompt: String,
    app_handle: tauri::AppHandle,
    state: Arc<Mutex<HashMap<String, AgentProcess>>>,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();

    let mut cmd = match &backend {
        AgentBackend::Snap => {
            // Inference snaps expose an OpenAI-compatible API at localhost:9090
            // Use curl to send a chat completion request
            let mut c = Command::new("curl");
            c.arg("-s");
            c.arg("-X");
            c.arg("POST");
            c.arg("http://localhost:9090/v1/chat/completions");
            c.arg("-H");
            c.arg("Content-Type: application/json");
            c.arg("-d");
            c.arg(format!(
                r#"{{"model":"{}","messages":[{{"role":"user","content":"{}"}}],"stream":false}}"#,
                model,
                prompt.replace('"', "\\\""),
            ));
            c
        }
        AgentBackend::Ollama => {
            let mut c = Command::new("ollama");
            c.arg("run");
            c.arg(&model);
            c.arg(&prompt);
            c
        }
    };

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());

    let binary_name = match &backend {
        AgentBackend::Snap => "snap-inference",
        AgentBackend::Ollama => "ollama",
    };

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {binary_name}: {e}"))?;

    // Take stdout and stderr handles before storing child
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    // Store session
    {
        let mut sessions = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
        sessions.insert(
            session_id.clone(),
            AgentProcess {
                name: name.clone(),
                model: model.clone(),
                backend: backend.clone(),
                prompt: prompt.clone(),
                child,
                status: "running".to_string(),
            },
        );
    }

    // Spawn stdout reader thread
    let sid_out = session_id.clone();
    let handle_out = app_handle.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    let _ = handle_out.emit(
                        "agent_output",
                        AgentOutputEvent {
                            session_id: sid_out.clone(),
                            stream: "stdout".to_string(),
                            line: text,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    // Spawn stderr reader thread
    let sid_err = session_id.clone();
    let handle_err = app_handle.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    let _ = handle_err.emit(
                        "agent_output",
                        AgentOutputEvent {
                            session_id: sid_err.clone(),
                            stream: "stderr".to_string(),
                            line: text,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    // Spawn wait thread — detects process exit and updates state.
    //
    // CRITICAL: never hold the `sessions` Mutex across a blocking `child.wait()`.
    // Doing so pins the lock for the entire lifetime of the agent process, so
    // every other RPC (`stop`, `list`, `remove`, and the next `spawn`'s insert)
    // blocks on `state.lock()` indefinitely — and `stop` can't acquire the lock
    // to kill the child, so the child never exits: a true deadlock that hangs
    // the whole agent panel. Instead we poll `try_wait()` under a brief lock and
    // release it (and sleep) between polls, so `stop` can grab the lock and kill
    // the child between two polls; the next poll reaps it.
    let sid_wait = session_id.clone();
    let state_wait = state.clone();
    std::thread::spawn(move || {
        let exit_code = wait_for_exit(&state_wait, &sid_wait);
        let _ = app_handle.emit(
            "agent_exit",
            AgentExitEvent {
                session_id: sid_wait,
                code: exit_code,
            },
        );
    });

    Ok(session_id)
}

/// Block until the agent child for `sid` exits, recording its terminal status.
///
/// CRITICAL: never hold the `sessions` Mutex across a blocking `child.wait()`.
/// Doing so pins the lock for the entire lifetime of the agent process, so
/// every other RPC (`stop`, `list`, `remove`, and the next `spawn`'s insert)
/// blocks on `state.lock()` indefinitely — and `stop` can't acquire the lock to
/// kill the child, so the child never exits: a true deadlock that hangs the
/// whole agent panel. Instead we poll `try_wait()` under a brief lock and
/// release it (and sleep) between polls, so `stop` can grab the lock and kill
/// the child between two polls; the next poll reaps it.
///
/// Returns the child's exit code, or `None` if the session was removed, the
/// lock was poisoned, or the wait itself errored.
fn wait_for_exit(state: &Arc<Mutex<HashMap<String, AgentProcess>>>, sid: &str) -> Option<i32> {
    let poll_interval = std::time::Duration::from_millis(100);
    loop {
        // Briefly lock only to poll; the guard is dropped at the end of this
        // block, well before the sleep below.
        let poll = match state.lock() {
            Ok(mut sessions) => match sessions.get_mut(sid) {
                Some(proc) => proc.child.try_wait(),
                // Session removed out from under us — stop waiting.
                None => return None,
            },
            // Lock poisoned — give up rather than spin forever.
            Err(_) => return None,
        };

        match poll {
            Ok(Some(status)) => {
                // Exited. Record the terminal status under a brief lock, but
                // don't clobber an explicit "stopped" already set by `stop`
                // (a killed child reports unsuccessful, yet the user asked to
                // stop it — that's a clean stop, not an error).
                if let Ok(mut sessions) = state.lock() {
                    if let Some(proc) = sessions.get_mut(sid) {
                        if proc.status == "running" {
                            proc.status = if status.success() {
                                "stopped".to_string()
                            } else {
                                "errored".to_string()
                            };
                        }
                    }
                }
                return status.code();
            }
            // Still running — sleep WITHOUT holding the lock, then re-poll.
            Ok(None) => std::thread::sleep(poll_interval),
            Err(_) => {
                if let Ok(mut sessions) = state.lock() {
                    if let Some(proc) = sessions.get_mut(sid) {
                        if proc.status == "running" {
                            proc.status = "errored".to_string();
                        }
                    }
                }
                return None;
            }
        }
    }
}

/// Stop a running agent process.
pub fn stop(
    session_id: &str,
    state: Arc<Mutex<HashMap<String, AgentProcess>>>,
) -> Result<(), String> {
    let mut sessions = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    if let Some(proc) = sessions.get_mut(session_id) {
        proc.child
            .kill()
            .map_err(|e| format!("Failed to kill agent: {e}"))?;
        proc.status = "stopped".to_string();
        Ok(())
    } else {
        Err(format!("No agent session with id {session_id}"))
    }
}

/// List all agent sessions with their current status.
pub fn list(
    state: Arc<Mutex<HashMap<String, AgentProcess>>>,
) -> Result<Vec<AgentSessionInfo>, String> {
    let sessions = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    let list: Vec<AgentSessionInfo> = sessions
        .iter()
        .map(|(id, proc)| AgentSessionInfo {
            id: id.clone(),
            name: proc.name.clone(),
            model: proc.model.clone(),
            backend: proc.backend.clone(),
            prompt: proc.prompt.clone(),
            status: proc.status.clone(),
            pid: None,
        })
        .collect();
    Ok(list)
}

/// Kill every still-running agent child.
///
/// Tauri's exit path reaches `std::process::exit`, which does not run
/// destructors, so a `Drop` impl would not fire and long-lived children such as
/// `ollama run` would outlive the app. The kill is issued under the lock and we
/// deliberately do not `wait()`, since the reaper thread polls for the same
/// lock and the process is terminating anyway.
pub fn kill_all(state: Arc<Mutex<HashMap<String, AgentProcess>>>) {
    let Ok(mut sessions) = state.lock() else {
        return;
    };
    for proc in sessions.values_mut() {
        if proc.status == "running" {
            let _ = proc.child.kill();
            proc.status = "stopped".to_string();
        }
    }
}

/// Remove a stopped/errored session from the session map.
pub fn remove(
    session_id: &str,
    state: Arc<Mutex<HashMap<String, AgentProcess>>>,
) -> Result<(), String> {
    let mut sessions = state.lock().map_err(|e| format!("Lock poisoned: {e}"))?;
    if let Some(proc) = sessions.get(session_id) {
        if proc.status == "running" {
            return Err("Cannot remove a running agent — stop it first".to_string());
        }
    }
    sessions
        .remove(session_id)
        .ok_or_else(|| format!("No agent session with id {session_id}"))?;
    Ok(())
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Serde contract for AgentBackend — the frontend relies on exact
    // string tags for Snap/Ollama when configuring an agent spawn call.
    #[test]
    fn agent_backend_serializes_to_expected_tag() {
        let snap = serde_json::to_string(&AgentBackend::Snap).unwrap();
        let ollama = serde_json::to_string(&AgentBackend::Ollama).unwrap();
        assert_eq!(snap, "\"Snap\"");
        assert_eq!(ollama, "\"Ollama\"");
    }

    #[test]
    fn agent_backend_deserializes_from_tag() {
        let snap: AgentBackend = serde_json::from_str("\"Snap\"").unwrap();
        let ollama: AgentBackend = serde_json::from_str("\"Ollama\"").unwrap();
        assert!(matches!(snap, AgentBackend::Snap));
        assert!(matches!(ollama, AgentBackend::Ollama));
    }

    // For state-machine tests we need real `Child` instances. The tests are
    // gated on `unix` because constructing a portable short-lived child
    // cross-platform is more trouble than it's worth; Studio's primary dev
    // and CI targets are macOS and Linux.
    #[cfg(unix)]
    fn make_exited_process(name: &str, status: &str) -> AgentProcess {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("exit 0")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .expect("spawn exit 0");
        // Wait so the child becomes a zombie that's already reaped; state tests
        // don't actually touch the Child unless `stop` is called.
        let _ = child.wait();
        AgentProcess {
            name: name.into(),
            model: "test-model".into(),
            backend: AgentBackend::Ollama,
            prompt: "hi".into(),
            child,
            status: status.into(),
        }
    }

    #[cfg(unix)]
    fn state_with(procs: Vec<(String, AgentProcess)>) -> Arc<Mutex<HashMap<String, AgentProcess>>> {
        let mut map = HashMap::new();
        for (id, proc) in procs {
            map.insert(id, proc);
        }
        Arc::new(Mutex::new(map))
    }

    #[cfg(unix)]
    #[test]
    fn list_returns_empty_for_no_sessions() {
        let state = state_with(vec![]);
        let out = list(state).unwrap();
        assert_eq!(out.len(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn list_projects_sessions_to_info() {
        let state = state_with(vec![
            ("s1".into(), make_exited_process("alice", "stopped")),
            ("s2".into(), make_exited_process("bob", "errored")),
        ]);
        let mut out = list(state).unwrap();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "s1");
        assert_eq!(out[0].name, "alice");
        assert_eq!(out[0].status, "stopped");
        assert_eq!(out[1].id, "s2");
        assert_eq!(out[1].name, "bob");
        assert_eq!(out[1].status, "errored");
    }

    #[cfg(unix)]
    #[test]
    fn remove_rejects_running_session() {
        let state = state_with(vec![("s1".into(), make_exited_process("a", "running"))]);
        let err = remove("s1", state.clone()).unwrap_err();
        assert!(
            err.contains("running"),
            "error should mention 'running', got: {err}"
        );
        // Session must still be present.
        assert_eq!(list(state).unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn remove_succeeds_on_stopped_session() {
        let state = state_with(vec![("s1".into(), make_exited_process("a", "stopped"))]);
        remove("s1", state.clone()).unwrap();
        assert_eq!(list(state).unwrap().len(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn remove_errors_on_unknown_session() {
        let state = state_with(vec![]);
        let err = remove("nope", state).unwrap_err();
        assert!(err.contains("nope"), "error should mention the id: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn stop_errors_on_unknown_session() {
        let state = state_with(vec![]);
        let err = stop("nope", state).unwrap_err();
        assert!(err.contains("nope"), "error should mention the id: {err}");
    }

    // A still-running child (sleep 30) — does NOT wait for it, unlike
    // make_exited_process. Used by the deadlock regression test below.
    #[cfg(unix)]
    fn make_running_process(name: &str) -> AgentProcess {
        let child = Command::new("sh")
            .arg("-c")
            .arg("sleep 30")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .expect("spawn sleep 30");
        AgentProcess {
            name: name.into(),
            model: "test-model".into(),
            backend: AgentBackend::Ollama,
            prompt: "hi".into(),
            child,
            status: "running".into(),
        }
    }

    // Regression for the agent-panel deadlock: wait_for_exit must not hold the
    // sessions lock across the blocking wait. With a running child, stop() (which
    // needs the lock to kill the child) must succeed promptly while wait_for_exit
    // is polling, and the waiter must then observe the exit and return. Before the
    // fix the wait thread pinned the lock for the child's full lifetime and stop()
    // hung indefinitely.
    #[cfg(unix)]
    #[test]
    fn wait_for_exit_does_not_block_stop() {
        use std::time::{Duration, Instant};

        let state = state_with(vec![("s1".into(), make_running_process("a"))]);
        let state_wait = state.clone();
        let waiter = std::thread::spawn(move || wait_for_exit(&state_wait, "s1"));

        // Let the waiter enter its poll loop.
        std::thread::sleep(Duration::from_millis(50));

        // Must NOT block: pre-fix, the wait thread held the lock for the child's
        // full 30s lifetime and this stop() would hang.
        let start = Instant::now();
        stop("s1", state.clone()).expect("stop should acquire the lock and kill the child");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "stop() blocked — the sessions lock was held across wait()"
        );

        // The waiter observes the exit and returns within a bounded time.
        let code = waiter.join().expect("waiter thread panicked");
        // SIGKILL'd children have no exit code on unix.
        assert!(code.is_none(), "killed child should have no exit code, got {code:?}");

        // stop() set "stopped"; the waiter must not have clobbered it to "errored".
        let sessions = list(state).unwrap();
        assert_eq!(sessions[0].status, "stopped");
    }
}
