use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::Emitter;
use ts_rs::TS;

/// Event payload sent from local shell to frontend.
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct ShellOutputEvent {
    pub session_id: String,
    pub data: String, // base64-encoded
}

/// Event payload for shell exit.
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct ShellExitEvent {
    pub session_id: String,
    pub reason: String,
}

pub struct LocalShellSession {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Managed Tauri state for local shell sessions.
pub struct LocalShellState {
    pub sessions: Arc<Mutex<HashMap<String, LocalShellSession>>>,
}

impl Default for LocalShellState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Pick the default shell program for the current OS when the caller hasn't
/// specified one. On Windows we default to `wsl.exe` so users land in their
/// WSL environment (RevDev's daily driver) instead of CMD. On other
/// platforms we honour `$SHELL`, falling back to `/bin/bash`.
fn default_shell_program() -> String {
    if cfg!(target_os = "windows") {
        // `wsl.exe` is on PATH on every Windows 10/11 install that has WSL
        // enabled. If it isn't, the PTY spawn will fail with a clear error
        // and the frontend can offer `powershell.exe` as an explicit pick.
        return "wsl.exe".to_string();
    }
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

/// Whether the given shell program should be invoked with `--login`. Only
/// POSIX shells understand that flag; passing it to `wsl.exe`, `cmd.exe`,
/// or `powershell.exe` makes them choke.
fn wants_login_flag(shell: &str) -> bool {
    let name = std::path::Path::new(shell)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();
    matches!(name.as_str(), "bash" | "zsh" | "sh" | "dash" | "ksh" | "fish")
}

/// Open a local PTY shell. Returns session ID.
pub fn open(
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell_program: Option<String>,
    app_handle: tauri::AppHandle,
    state: Arc<Mutex<HashMap<String, LocalShellSession>>>,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();

    let pty_system = NativePtySystem::default();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let shell = shell_program.unwrap_or_else(default_shell_program);
    let mut cmd = CommandBuilder::new(&shell);
    if wants_login_flag(&shell) {
        cmd.arg("--login");
    }

    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    // Store session
    {
        let mut sessions = state
            .lock()
            .map_err(|e| format!("Lock poisoned: {e}"))?;
        sessions.insert(
            session_id.clone(),
            LocalShellSession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    // Spawn reader thread — emits events to frontend
    let sid = session_id.clone();
    let state_clone = state.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = app_handle.emit(
                        "shell_exit",
                        ShellExitEvent {
                            session_id: sid.clone(),
                            reason: "Shell exited".to_string(),
                        },
                    );
                    break;
                }
                Ok(n) => {
                    let encoded = BASE64.encode(&buf[..n]);
                    let _ = app_handle.emit(
                        "shell_output",
                        ShellOutputEvent {
                            session_id: sid.clone(),
                            data: encoded,
                        },
                    );
                }
            }
        }

        // Clean up session
        if let Ok(mut sessions) = state_clone.lock() {
            sessions.remove(&sid);
        }
    });

    Ok(session_id)
}
