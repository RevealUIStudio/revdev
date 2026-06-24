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

    /// Run an arbitrary command inside WSL (`wsl.exe -d <distro> -e <args>`).
    pub async fn run(args: &[&str]) -> Result<std::process::Output, String> {
        let distro = distro();
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["-d", &distro, "-e"]).args(args);
        cmd.output()
            .await
            .map_err(|e| format!("wsl.exe failed: {e}"))
    }

    /// Run `systemctl --user <args>` inside WSL and capture its output.
    pub async fn systemctl(args: &[&str]) -> Result<std::process::Output, String> {
        let mut full = vec!["systemctl", "--user"];
        full.extend_from_slice(args);
        run(&full).await
    }

    /// Whether the WSL distro's systemd manager is up (the first-run gate).
    /// `systemctl is-system-running` reports `running`/`degraded` when systemd
    /// is active; `offline` or an error means systemd isn't enabled yet.
    pub async fn is_system_running() -> bool {
        match run(&["systemctl", "is-system-running"]).await {
            Ok(out) => {
                let s = String::from_utf8_lossy(&out.stdout);
                matches!(s.trim(), "running" | "degraded")
            }
            Err(_) => false,
        }
    }

    /// Ensure WSL systemd is enabled. If not, write `systemd=true` to
    /// /etc/wsl.conf and return an ACTIONABLE error — enabling systemd needs a
    /// one-time `wsl --shutdown` from Windows, so setup must stop here loudly
    /// rather than silently no-op (ADR P4 gate).
    pub async fn ensure_systemd() -> Result<(), String> {
        if is_system_running().await {
            return Ok(());
        }
        // Best-effort: append the [boot] systemd=true stanza (idempotent) using
        // the WSL user's sudo. Either way we return an error — systemd only
        // takes effect after a shutdown.
        let _ = run(&[
            "bash",
            "-lc",
            "grep -qs '^systemd=true' /etc/wsl.conf || \
             printf '[boot]\\nsystemd=true\\n' | sudo tee -a /etc/wsl.conf >/dev/null",
        ])
        .await;
        Err(
            "WSL systemd is not enabled. `systemd=true` has been written to \
             /etc/wsl.conf (if sudo allowed it); run `wsl --shutdown` from a \
             Windows terminal, reopen WSL, then re-run setup. If the write was \
             refused, add this to /etc/wsl.conf inside WSL manually:\n\n  \
             [boot]\n  systemd=true"
                .to_string(),
        )
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
    /// Whether the systemd-user manager that owns the daemon is available.
    /// On Windows this is `systemctl is-system-running` inside WSL — `false`
    /// means systemd-user isn't enabled yet (first-run setup required), which
    /// the UI must surface DISTINCTLY from a merely-stopped daemon. Always
    /// `true` on native Unix (the daemon runs as a local process, not gated by
    /// a WSL systemd manager).
    pub systemd_available: bool,
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
        systemd_available: true, // not gated by a WSL systemd manager on native Unix
    })
}

#[cfg(not(unix))]
#[tauri::command]
pub async fn daemon_status() -> Result<DaemonStatus, String> {
    // Liveness from systemd (NOT the ext4 PID file); reachability from a ping
    // over the relay. systemd_available lets the UI distinguish "needs first-run
    // setup" from "stopped".
    let systemd_available = wsl::is_system_running().await;
    let running = systemd_available && wsl::is_active().await;
    let pid = wsl::main_pid().await;
    let reachable = crate::harness::rpc_call("ping", serde_json::json!({}))
        .await
        .is_ok();

    Ok(DaemonStatus {
        running,
        pid,
        reachable,
        systemd_available,
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

// ── First-run setup ───────────────────────────────────────────────────────────

/// Root-owned trust anchor path the daemon reads at client-key enrollment time.
/// MUST match `DaemonConfig.trustedClientFingerprintPath` in
/// packages/daemon/src/config.ts.
#[cfg(any(not(unix), test))]
const TRUST_ANCHOR_PATH: &str = "/etc/revdev/trusted-client-fingerprint";

/// Validate the anchor components before they are shell-interpolated into the
/// provisioning script: the agentId is [A-Za-z0-9._-] and the base58 (bs58)
/// fingerprint is ASCII-alphanumeric — both non-empty, neither containing a
/// `:` (the anchor delimiter) or any shell metacharacter, so a malformed
/// identity file can never inject shell. Platform-independent + unit-tested on
/// Linux even though the only caller is the not(unix) WSL `daemon_setup`.
#[cfg(any(not(unix), test))]
fn validate_anchor_components(agent_id: &str, fp: &str) -> Result<(), String> {
    let ok_agent =
        !agent_id.is_empty() && agent_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok_agent {
        return Err(format!("refusing to provision a malformed agentId: {agent_id:?}"));
    }
    if fp.is_empty() || !fp.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("refusing to provision a malformed client fingerprint: {fp:?}"));
    }
    Ok(())
}

/// Build the sudo script that writes `agentId:fingerprint` to the root-owned
/// trust anchor. The agentId is bound (not just the key) so one trusted key
/// cannot enroll under arbitrary agentIds (review B-3). It OVERWRITES (not
/// appends), so re-running setup after a rotation replaces the value rather
/// than accumulating stale keys. Callers MUST `validate_anchor_components` first.
#[cfg(any(not(unix), test))]
fn build_trust_anchor_provision_script(agent_id: &str, fp: &str) -> String {
    let path = TRUST_ANCHOR_PATH;
    format!(
        "set -e; \
         sudo mkdir -p /etc/revdev; \
         printf '%s\\n' '{agent_id}:{fp}' | sudo tee {path} >/dev/null; \
         sudo chmod 0644 {path}"
    )
}

/// Provision the WSL side on Windows: assert systemd is enabled (writing the
/// gate + failing with an actionable error if not), stage the bundled relay
/// into `~/.local/bin`, and enable the daemon's systemd-user unit. Returns a
/// human-readable summary. Idempotent.
///
/// NOTE: the daemon itself (a Node tsup bundle) is expected to already be
/// present in WSL via packages/daemon/systemd/install.sh; embedding + staging
/// the full daemon payload into the Windows installer is the remaining
/// release-engineering step (tracked in the P4 PR).
#[cfg(not(unix))]
#[tauri::command]
pub async fn daemon_setup(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    // Gate: stops here with actionable `wsl --shutdown` guidance if systemd-user
    // isn't available yet.
    wsl::ensure_systemd().await?;

    // Resolve the payload dir holding the bundled Linux relay binary.
    let payload = match std::env::var("REVDEV_SETUP_PAYLOAD") {
        Ok(p) => std::path::PathBuf::from(p),
        Err(_) => app
            .path()
            .resource_dir()
            .map_err(|e| format!("cannot resolve resource dir: {e}"))?
            .join("wsl"),
    };
    let payload_str = payload.to_string_lossy().to_string();

    // Translate the Windows path to a WSL path so the relay can be copied in.
    let wp = wsl::run(&["wslpath", "-a", &payload_str]).await?;
    if !wp.status.success() {
        return Err(format!(
            "wslpath failed for {payload_str}: {}",
            String::from_utf8_lossy(&wp.stderr).trim()
        ));
    }
    let wsl_payload = String::from_utf8_lossy(&wp.stdout).trim().to_string();

    let script = format!(
        "set -e; \
         mkdir -p \"$HOME/.local/bin\"; \
         cp '{wsl_payload}/revdev-relay' \"$HOME/.local/bin/revdev-relay\"; \
         chmod +x \"$HOME/.local/bin/revdev-relay\"; \
         systemctl --user daemon-reload; \
         systemctl --user enable --now {}",
        wsl::DAEMON_UNIT
    );
    let out = wsl::run(&["bash", "-lc", &script]).await?;
    if !out.status.success() {
        return Err(format!(
            "WSL setup failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    // Provision the client trust anchor. The daemon rejects enrollment of any
    // (agentId, key) pair not in this ROOT-OWNED file (a host process running as
    // the WSL user could forge a user-owned file, so the anchor must be
    // root:root). Write THIS install's Studio (agentId, fingerprint) pair —
    // "one install == one trusted client key". Overwrites (not appends) so
    // re-running setup after a rotation replaces the old value.
    let identity = crate::signing::load_or_create_identity()?;
    let agent_id = identity.agent_id;
    let fp = identity.fingerprint;
    // Validation + script construction are platform-independent helpers (unit-
    // tested on Linux CI); only the wsl::run execution below is Windows-only.
    validate_anchor_components(&agent_id, &fp)?;
    let provision = build_trust_anchor_provision_script(&agent_id, &fp);
    let pout = wsl::run(&["bash", "-lc", &provision]).await?;
    if !pout.status.success() {
        return Err(format!(
            "Relay installed, but provisioning the client trust anchor failed (needs sudo). \
             The daemon will reject Studio's key until \
             /etc/revdev/trusted-client-fingerprint contains this entry. Run inside \
             WSL, then re-run setup:\n\n  \
             echo '{agent_id}:{fp}' | sudo tee /etc/revdev/trusted-client-fingerprint\n\nsudo error: {}",
            String::from_utf8_lossy(&pout.stderr).trim()
        ));
    }

    Ok("RevDev relay installed, client trust anchor provisioned, daemon enabled in WSL.".to_string())
}

/// Native Unix: the daemon runs as a local process; no WSL staging is needed.
/// Register a systemd-user unit with packages/daemon/systemd/install.sh.
///
/// NOTE: the client-key enrollment gate still applies on native Unix — a
/// native-Unix Studio install must provision its signing fingerprint into the
/// root-owned trust anchor (default `/etc/revdev/trusted-client-fingerprint`,
/// or REVDEV_DAEMON_TRUSTED_CLIENT_FP) or the daemon rejects its key. This is
/// left to install.sh / a manual step here because native Unix is the dev/test
/// surface (tests point the daemon at a fixture anchor); production ships
/// Windows Studio + WSL daemon, handled by the not(unix) daemon_setup above.
#[cfg(unix)]
#[tauri::command]
pub async fn daemon_setup(_app: tauri::AppHandle) -> Result<String, String> {
    Ok("No WSL setup required on this platform.".to_string())
}

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

#[cfg(test)]
mod tests {
    use super::{build_trust_anchor_provision_script, validate_anchor_components, TRUST_ANCHOR_PATH};

    #[test]
    fn validate_accepts_a_studio_agent_and_base58_fingerprint() {
        // Representative agentId ("studio-...") + bs58 fingerprint.
        assert!(
            validate_anchor_components("studio-abc123", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy").is_ok()
        );
    }

    #[test]
    fn validate_rejects_empty_and_shell_metacharacters() {
        // Bad fingerprint.
        assert!(validate_anchor_components("studio-x", "").is_err());
        assert!(validate_anchor_components("studio-x", "abc'; rm -rf /").is_err());
        assert!(validate_anchor_components("studio-x", "with space").is_err());
        assert!(validate_anchor_components("studio-x", "with/slash").is_err());
        // Bad agentId — empty, colon (anchor delimiter), or shell metachars.
        assert!(validate_anchor_components("", "ABC123").is_err());
        assert!(validate_anchor_components("evil:agent", "ABC123").is_err());
        assert!(validate_anchor_components("$(touch pwned)", "ABC123").is_err());
        assert!(validate_anchor_components("a b", "ABC123").is_err());
    }

    #[test]
    fn provision_script_embeds_agent_id_fingerprint_pair_and_anchor_path() {
        let s = build_trust_anchor_provision_script("studio-xyz", "ABC123xyz");
        assert!(s.contains("printf '%s\\n' 'studio-xyz:ABC123xyz'"));
        assert!(s.contains(TRUST_ANCHOR_PATH));
        assert!(s.contains("sudo tee"));
        assert!(s.contains("sudo chmod 0644"));
    }
}
