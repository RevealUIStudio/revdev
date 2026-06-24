//! Daemon lifecycle control — start/stop/restart from the Studio UI.
//!
//! Two lifecycle models (zero-9P, ADR 2026-06-23, P3):
//!   - **Native Unix** (Linux/macOS Studio): the daemon is a local process, so
//!     we spawn it directly and stop it with SIGTERM, tracking liveness via the
//!     PID file (no 9P boundary in play).
//!   - **Windows**: the daemon lives inside WSL and is owned by a `systemd
//!     --user` unit (`revdev-daemon`). Studio drives it with
//!     `wsl.exe ... systemctl --user ...` and never reads the ext4 PID file —
//!     liveness is `systemctl is-active`, reachability is a `ping` RPC over the
//!     relay. This removes the last Windows→ext4 read, which the 9P redirector
//!     could otherwise serve stale.

use serde::Serialize;
use std::time::Duration;
use tokio::time::sleep;
use ts_rs::TS;

// ── Native Unix: PID-file + direct process control ──────────────────────────

/// PID file location (mirrors DAEMON_DEFAULTS.pidFile in the Node daemon).
#[cfg(unix)]
fn pid_file_path() -> std::path::PathBuf {
    if let Ok(path) = std::env::var("REVDEV_DAEMON_PID") {
        return std::path::PathBuf::from(path);
    }
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
        .join(".local/share/revealui/harness.pid")
}

/// Resolve the daemon binary location (native Unix spawn only).
#[cfg(unix)]
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

    Err("revdev-daemon not found. Install it to ~/.local/bin/ or add to PATH.".to_string())
}

/// Read PID from the PID file. Returns None if file doesn't exist or is unreadable.
#[cfg(unix)]
fn read_pid() -> Option<u32> {
    std::fs::read_to_string(pid_file_path())
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

/// Check if a process with the given PID is running.
#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    // Signal 0 checks process existence without actually sending a signal.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

// ── Windows: systemd-user-in-WSL control ────────────────────────────────────

#[cfg(not(unix))]
mod wsl {
    use tokio::process::Command;

    /// systemd-user unit that owns the daemon inside WSL (see
    /// packages/daemon/systemd/revdev-daemon.service).
    pub const DAEMON_UNIT: &str = "revdev-daemon";

    fn distro() -> String {
        std::env::var("REVDEV_WSL_DISTRO").unwrap_or_else(|_| "Ubuntu".to_string())
    }

    /// Run `systemctl --user <args>` inside WSL and capture its output.
    pub async fn systemctl(args: &[&str]) -> Result<std::process::Output, String> {
        let distro = distro();
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["-d", &distro, "-e", "systemctl", "--user"])
            .args(args);
        cmd.output()
            .await
            .map_err(|e| format!("wsl.exe systemctl failed: {e}"))
    }

    /// True when the daemon unit reports `active`.
    pub async fn is_active() -> bool {
        match systemctl(&["is-active", DAEMON_UNIT]).await {
            Ok(out) => String::from_utf8_lossy(&out.stdout).trim() == "active",
            Err(_) => false,
        }
    }

    /// The unit's MainPID, or None when inactive (systemd reports 0).
    pub async fn main_pid() -> Option<u32> {
        let out = systemctl(&["show", "-p", "MainPID", "--value", DAEMON_UNIT])
            .await
            .ok()?;
        let pid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
        (pid != 0).then_some(pid)
    }
}

// ── Status ──────────────────────────────────────────────────────────────────

#[derive(Clone, Serialize, TS)]
#[ts(export)]
pub struct DaemonStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub reachable: bool,
}

/// Check if the daemon is running and reachable.
#[cfg(unix)]
#[tauri::command]
pub async fn daemon_status() -> Result<DaemonStatus, String> {
    let pid = read_pid();
    let process_alive = pid.is_some_and(is_pid_alive);
    let reachable = crate::harness::rpc_call("ping", serde_json::json!({}))
        .await
        .is_ok();

    Ok(DaemonStatus {
        running: process_alive,
        pid,
        reachable,
    })
}

#[cfg(not(unix))]
#[tauri::command]
pub async fn daemon_status() -> Result<DaemonStatus, String> {
    // Liveness from systemd (NOT the ext4 PID file); reachability from a ping
    // over the relay.
    let running = wsl::is_active().await;
    let pid = wsl::main_pid().await;
    let reachable = crate::harness::rpc_call("ping", serde_json::json!({}))
        .await
        .is_ok();

    Ok(DaemonStatus {
        running,
        pid,
        reachable,
    })
}

// ── Start ─────────────────────────────────────────────────────────────────────

/// Start the daemon. Returns the new PID on success.
#[cfg(unix)]
#[tauri::command]
pub async fn daemon_start() -> Result<u32, String> {
    if let Some(pid) = read_pid() {
        if is_pid_alive(pid) {
            return Err(format!("Daemon already running (PID {pid})"));
        }
    }

    let bin = daemon_binary()?;
    use std::process::{Command, Stdio};

    let child = Command::new(&bin)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start daemon: {e}"))?;

    let pid = child.id();

    // Reap the child when it eventually exits. Without this, the exited daemon
    // lingers as a zombie of THIS process — and `is_pid_alive` (kill 0) counts
    // zombies as alive, so daemon_stop would report "did not exit within 10s"
    // for a daemon that exited cleanly. Surfaced by daemon_ctl_integration.rs.
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });

    // Wait for the socket to become reachable (up to 5s). Return an error
    // rather than a false-success if the child exited (bind/startup failure).
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
#[tauri::command]
pub async fn daemon_start() -> Result<u32, String> {
    if wsl::is_active().await {
        let pid = wsl::main_pid().await.unwrap_or(0);
        return Err(format!("Daemon already running (PID {pid})"));
    }

    let out = wsl::systemctl(&["start", wsl::DAEMON_UNIT]).await?;
    if !out.status.success() {
        return Err(format!(
            "systemctl --user start {} failed: {}",
            wsl::DAEMON_UNIT,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    // Wait for reachability over the relay (up to 5s).
    for _ in 0..50 {
        sleep(Duration::from_millis(100)).await;
        if crate::harness::rpc_call("ping", serde_json::json!({}))
            .await
            .is_ok()
        {
            return Ok(wsl::main_pid().await.unwrap_or(0));
        }
    }

    Err("Daemon started via systemctl but did not become reachable within 5s".to_string())
}

// ── Stop ──────────────────────────────────────────────────────────────────────

/// Stop the daemon.
#[cfg(unix)]
#[tauri::command]
pub async fn daemon_stop() -> Result<(), String> {
    let pid = read_pid().ok_or("No PID file found — daemon may not be running")?;

    if !is_pid_alive(pid) {
        let _ = std::fs::remove_file(pid_file_path());
        return Err(format!("PID {pid} is not running (stale PID file removed)"));
    }

    // Send SIGTERM for graceful shutdown.
    let result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    if result != 0 {
        return Err(format!("Failed to send SIGTERM to PID {pid}"));
    }

    // Wait for the process to exit (up to 10s).
    for _ in 0..100 {
        sleep(Duration::from_millis(100)).await;
        if !is_pid_alive(pid) {
            return Ok(());
        }
    }

    Err(format!("Daemon PID {pid} did not exit within 10s"))
}

#[cfg(not(unix))]
#[tauri::command]
pub async fn daemon_stop() -> Result<(), String> {
    let out = wsl::systemctl(&["stop", wsl::DAEMON_UNIT]).await?;
    if !out.status.success() {
        return Err(format!(
            "systemctl --user stop {} failed: {}",
            wsl::DAEMON_UNIT,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

// ── Restart ───────────────────────────────────────────────────────────────────

/// Restart the daemon: stop then start. Both halves are platform-specific
/// (direct process control on Unix; systemctl-in-WSL on Windows).
#[tauri::command]
pub async fn daemon_restart() -> Result<u32, String> {
    // Stop if running (ignore errors — may not be running).
    let _ = daemon_stop().await;

    // Brief pause to ensure the socket is released.
    sleep(Duration::from_millis(500)).await;

    daemon_start().await
}
