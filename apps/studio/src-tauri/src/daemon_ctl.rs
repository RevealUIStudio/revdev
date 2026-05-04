//! Daemon lifecycle control — start/stop/restart from the Studio UI.
//!
//! The daemon binary (`revdev-daemon`) is resolved via:
//!   1. `REVDEV_DAEMON_BIN` env var (override)
//!   2. `~/.local/bin/revdev-daemon` (standard install location)
//!   3. `which revdev-daemon` (system PATH)

use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tokio::time::sleep;
use ts_rs::TS;

/// PID file location (mirrors DAEMON_DEFAULTS.pidFile in the Node daemon).
fn pid_file_path() -> PathBuf {
    if let Ok(path) = std::env::var("REVDEV_DAEMON_PID") {
        return PathBuf::from(path);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".local/share/revealui/harness.pid")
}

/// Resolve the daemon binary location.
fn daemon_binary() -> Result<String, String> {
    // 1. Explicit override
    if let Ok(bin) = std::env::var("REVDEV_DAEMON_BIN") {
        return Ok(bin);
    }

    // 2. Standard install location
    if let Some(home) = dirs::home_dir() {
        let local_bin = home.join(".local/bin/revdev-daemon");
        if local_bin.exists() {
            return Ok(local_bin.to_string_lossy().into_owned());
        }
    }

    // 3. System PATH
    if let Ok(path) = which::which("revdev-daemon") {
        return Ok(path.to_string_lossy().into_owned());
    }

    Err(
        "revdev-daemon not found. Install it to ~/.local/bin/ or add to PATH.".to_string(),
    )
}

/// Read PID from the PID file. Returns None if file doesn't exist or is unreadable.
fn read_pid() -> Option<u32> {
    let path = pid_file_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

/// Check if a process with the given PID is running.
#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    // Signal 0 checks process existence without actually sending a signal
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(not(unix))]
fn is_pid_alive(_pid: u32) -> bool {
    false
}

#[derive(Clone, Serialize, TS)]
#[ts(export)]
pub struct DaemonStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub reachable: bool,
}

/// Check if the daemon is running and reachable.
#[tauri::command]
pub async fn daemon_status() -> Result<DaemonStatus, String> {
    let pid = read_pid();
    let process_alive = pid.map_or(false, is_pid_alive);
    let reachable = crate::harness::rpc_call("ping", serde_json::json!({}))
        .await
        .is_ok();

    Ok(DaemonStatus {
        running: process_alive,
        pid,
        reachable,
    })
}

/// Start the daemon as a detached background process.
/// Returns the new PID on success.
#[tauri::command]
pub async fn daemon_start() -> Result<u32, String> {
    // Check if already running
    if let Some(pid) = read_pid() {
        if is_pid_alive(pid) {
            return Err(format!("Daemon already running (PID {pid})"));
        }
    }

    let bin = daemon_binary()?;

    #[cfg(unix)]
    {
        use std::process::{Command, Stdio};

        let child = Command::new(&bin)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start daemon: {e}"))?;

        let pid = child.id();

        // Wait for socket to become reachable (up to 5s).
        // If the daemon never becomes reachable, return an error rather than
        // a false-success Ok(pid) — the child may have exited (bind/startup
        // failure, missing dependencies, etc.) and reporting Ok hides that.
        for _ in 0..50 {
            sleep(Duration::from_millis(100)).await;
            if crate::harness::rpc_call("ping", serde_json::json!({}))
                .await
                .is_ok()
            {
                return Ok(pid);
            }
        }

        Err(format!(
            "Daemon spawned (PID {pid}) but did not become reachable within 5s — likely exited or failed to bind socket"
        ))
    }

    #[cfg(not(unix))]
    {
        let _ = bin;
        Err("Daemon lifecycle management is not yet supported on this platform".to_string())
    }
}

/// Stop the daemon by sending SIGTERM to the PID from the PID file.
#[tauri::command]
pub async fn daemon_stop() -> Result<(), String> {
    let pid = read_pid().ok_or("No PID file found — daemon may not be running")?;

    if !is_pid_alive(pid) {
        // Clean up stale PID file
        let _ = std::fs::remove_file(pid_file_path());
        return Err(format!("PID {pid} is not running (stale PID file removed)"));
    }

    #[cfg(unix)]
    {
        // Send SIGTERM for graceful shutdown
        let result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        if result != 0 {
            return Err(format!("Failed to send SIGTERM to PID {pid}"));
        }

        // Wait for process to exit (up to 10s)
        for _ in 0..100 {
            sleep(Duration::from_millis(100)).await;
            if !is_pid_alive(pid) {
                return Ok(());
            }
        }

        Err(format!("Daemon PID {pid} did not exit within 10s"))
    }

    #[cfg(not(unix))]
    {
        let _ = pid;
        Err("Daemon lifecycle management is not yet supported on this platform".to_string())
    }
}

/// Restart the daemon: stop then start.
#[tauri::command]
pub async fn daemon_restart() -> Result<u32, String> {
    // Stop if running (ignore errors — may not be running)
    let _ = daemon_stop().await;

    // Brief pause to ensure socket is released
    sleep(Duration::from_millis(500)).await;

    daemon_start().await
}
