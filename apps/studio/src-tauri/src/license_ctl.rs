//! Studio-managed license KEY_FILE materialization + local verify.
//!
//! Write/wipe only touch the canonical path + `license.jwt.managed` marker.
//! Unix injects KEY_FILE on spawn (see `daemon_ctl::daemon_start`); Windows
//! installs `studio-license.conf` inside WSL (never overwrites operator
//! `license-file.conf`).

use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Serialize, TS)]
#[ts(export)]
pub struct LicenseVerifyLocalResult {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Clone, Serialize, TS)]
#[ts(export)]
pub struct LicenseWriteManagedResult {
    /// True when the jwt bytes were created or replaced (caller should restart).
    pub changed: bool,
}

#[derive(Clone, Serialize, TS)]
#[ts(export)]
pub struct LicenseWipeManagedResult {
    /// True when a managed wipe ran (marker was present).
    pub wiped: bool,
}

/// True when the Studio process itself has `REVEALUI_LICENSE_KEY` set.
#[tauri::command]
pub fn license_env_override() -> bool {
    match std::env::var("REVEALUI_LICENSE_KEY") {
        Ok(v) => !v.trim().is_empty(),
        Err(_) => false,
    }
}

/// Verify a JWT via `revdev-daemon license-verify` (stdin JWT, JSON stdout).
/// Does not persist. Missing binary → fail closed (`valid: false`).
#[tauri::command]
pub async fn license_verify_local(jwt: String) -> Result<LicenseVerifyLocalResult, String> {
    let token = jwt.trim();
    if token.is_empty() {
        return Ok(LicenseVerifyLocalResult {
            valid: false,
            code: Some("invalid-format".into()),
        });
    }

    #[cfg(unix)]
    {
        verify_local_unix(token).await
    }
    #[cfg(not(unix))]
    {
        verify_local_wsl(token).await
    }
}

/// Materialize `license.jwt` + `.managed` (Unix host or inside WSL).
/// Caller is responsible for vault_set and daemon_restart.
#[tauri::command]
pub async fn license_write_managed(jwt: String) -> Result<LicenseWriteManagedResult, String> {
    let token = jwt.trim();
    if token.is_empty() {
        return Err("refusing to write an empty license JWT".into());
    }
    if !token.starts_with("eyJ") {
        return Err("refusing to write a non-JWT license value".into());
    }

    #[cfg(unix)]
    {
        write_managed_unix(token)
    }
    #[cfg(not(unix))]
    {
        write_managed_wsl(token).await
    }
}

/// Wipe managed license files if `.managed` exists at the canonical path.
#[tauri::command]
pub async fn license_wipe_managed() -> Result<LicenseWipeManagedResult, String> {
    #[cfg(unix)]
    {
        wipe_managed_unix()
    }
    #[cfg(not(unix))]
    {
        wipe_managed_wsl().await
    }
}

// ── Unix host ────────────────────────────────────────────────────────────────

#[cfg(unix)]
fn atomic_write_0600(path: &std::path::Path, contents: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let parent = path
        .parent()
        .ok_or_else(|| format!("license path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("chmod 0700 {}: {e}", parent.display()))?;

    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("license.jwt"),
        std::process::id()
    ));

    {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("open temp {}: {e}", tmp.display()))?;
        file.write_all(contents)
            .map_err(|e| format!("write temp {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync temp {}: {e}", tmp.display()))?;
    }

    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename {} → {}: {e}", tmp.display(), path.display())
    })?;
    Ok(())
}

#[cfg(unix)]
fn write_managed_unix(jwt: &str) -> Result<LicenseWriteManagedResult, String> {
    let jwt_path = crate::daemon_ctl::canonical_license_file();
    let marker_path = jwt_path.with_file_name("license.jwt.managed");

    let previous = std::fs::read_to_string(&jwt_path).ok();
    let changed = previous.as_deref().map(str::trim) != Some(jwt);

    atomic_write_0600(&jwt_path, jwt.as_bytes())?;
    atomic_write_0600(&marker_path, b"")?;
    Ok(LicenseWriteManagedResult { changed })
}

#[cfg(unix)]
fn wipe_managed_unix() -> Result<LicenseWipeManagedResult, String> {
    let jwt_path = crate::daemon_ctl::canonical_license_file();
    let marker_path = jwt_path.with_file_name("license.jwt.managed");

    if !marker_path.is_file() {
        return Ok(LicenseWipeManagedResult { wiped: false });
    }

    unlink_ok(&jwt_path)?;
    unlink_ok(&marker_path)?;
    Ok(LicenseWipeManagedResult { wiped: true })
}

#[cfg(unix)]
fn unlink_ok(path: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("unlink {}: {e}", path.display())),
    }
}

#[cfg(unix)]
async fn verify_local_unix(jwt: &str) -> Result<LicenseVerifyLocalResult, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let bin = match crate::daemon_ctl::daemon_binary() {
        Ok(b) => b,
        Err(err) => {
            return Ok(LicenseVerifyLocalResult {
                valid: false,
                code: Some(format!("daemon-binary-missing:{err}")),
            });
        }
    };

    let mut child = Command::new(&bin)
        .arg("license-verify")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn license-verify: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(jwt.as_bytes())
            .map_err(|e| format!("write license-verify stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("wait license-verify: {e}"))?;
    parse_verify_stdout(&String::from_utf8_lossy(&output.stdout))
}

// ── Windows / WSL ────────────────────────────────────────────────────────────

#[cfg(not(unix))]
const WSL_LICENSE_DIR: &str = "$HOME/.local/share/revealui";
#[cfg(not(unix))]
const WSL_DROPIN_DIR: &str = "$HOME/.config/systemd/user/revdev-daemon.service.d";
#[cfg(not(unix))]
const WSL_DROPIN_NAME: &str = "studio-license.conf";

#[cfg(not(unix))]
async fn verify_local_wsl(jwt: &str) -> Result<LicenseVerifyLocalResult, String> {
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    let distro = crate::daemon_ctl::wsl::distro();
    // Resolve binary inside the distro; JWT stays on stdin (never argv).
    let script = "bin=\"${REVDEV_DAEMON_BIN:-$HOME/.local/bin/revdev-daemon}\"; \
         if [ ! -x \"$bin\" ]; then \
           if command -v revdev-daemon >/dev/null 2>&1; then bin=$(command -v revdev-daemon); \
           else echo '{\"valid\":false,\"code\":\"daemon-binary-missing\"}'; exit 1; fi; \
         fi; \
         exec \"$bin\" license-verify";

    let mut cmd = Command::new("wsl.exe");
    crate::win_process::hide_tokio(&mut cmd);
    cmd.args(["-d", &distro, "-e", "bash", "-lc", script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn wsl license-verify: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(jwt.as_bytes())
            .await
            .map_err(|e| format!("write wsl license-verify stdin: {e}"))?;
        stdin
            .shutdown()
            .await
            .map_err(|e| format!("close wsl license-verify stdin: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("wait wsl license-verify: {e}"))?;
    parse_verify_stdout(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(unix))]
async fn write_managed_wsl(jwt: &str) -> Result<LicenseWriteManagedResult, String> {
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    let distro = crate::daemon_ctl::wsl::distro();

    // Detect change by comparing existing jwt (best-effort).
    let prev = crate::daemon_ctl::wsl::run(&[
        "bash",
        "-lc",
        &format!("cat {WSL_LICENSE_DIR}/license.jwt 2>/dev/null || true"),
    ])
    .await
    .ok();
    let previous = prev
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let changed = previous != jwt;

    let write_script = format!(
        "set -euo pipefail; umask 077; \
         dir={WSL_LICENSE_DIR}; mkdir -p \"$dir\"; chmod 700 \"$dir\"; \
         tmp=\"$dir/license.jwt.tmp.$$\"; cat > \"$tmp\"; chmod 600 \"$tmp\"; \
         mv -f \"$tmp\" \"$dir/license.jwt\"; \
         : > \"$dir/license.jwt.managed\"; chmod 600 \"$dir/license.jwt.managed\"; \
         drop={WSL_DROPIN_DIR}; mkdir -p \"$drop\"; \
         printf '%s\\n' '[Service]' \
           'Environment=REVEALUI_LICENSE_KEY_FILE=%h/.local/share/revealui/license.jwt' \
           > \"$drop/{WSL_DROPIN_NAME}\"; \
         systemctl --user daemon-reload"
    );

    let mut cmd = Command::new("wsl.exe");
    crate::win_process::hide_tokio(&mut cmd);
    cmd.args(["-d", &distro, "-e", "bash", "-lc", &write_script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn wsl license write: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(jwt.as_bytes())
            .await
            .map_err(|e| format!("write wsl license stdin: {e}"))?;
        stdin
            .shutdown()
            .await
            .map_err(|e| format!("close wsl license stdin: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("wait wsl license write: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "WSL license write failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    Ok(LicenseWriteManagedResult { changed })
}

#[cfg(not(unix))]
async fn wipe_managed_wsl() -> Result<LicenseWipeManagedResult, String> {
    let marker_check = crate::daemon_ctl::wsl::run(&[
        "bash",
        "-lc",
        &format!("test -f {WSL_LICENSE_DIR}/license.jwt.managed && echo yes || echo no"),
    ])
    .await?;
    let has_marker = String::from_utf8_lossy(&marker_check.stdout).trim() == "yes";
    if !has_marker {
        return Ok(LicenseWipeManagedResult { wiped: false });
    }

    let wipe_script = format!(
        "set -euo pipefail; \
         rm -f {WSL_LICENSE_DIR}/license.jwt {WSL_LICENSE_DIR}/license.jwt.managed; \
         rm -f {WSL_DROPIN_DIR}/{WSL_DROPIN_NAME}; \
         systemctl --user daemon-reload || true"
    );
    let out = crate::daemon_ctl::wsl::run(&["bash", "-lc", &wipe_script]).await?;
    if !out.status.success() {
        return Err(format!(
            "WSL license wipe failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(LicenseWipeManagedResult { wiped: true })
}

// ── Shared parse ─────────────────────────────────────────────────────────────

fn parse_verify_stdout(stdout: &str) -> Result<LicenseVerifyLocalResult, String> {
    let line = stdout.lines().find(|l| l.trim().starts_with('{')).unwrap_or("");
    if line.is_empty() {
        return Ok(LicenseVerifyLocalResult {
            valid: false,
            code: Some("invalid-format".into()),
        });
    }
    let parsed: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("license-verify JSON: {e}"))?;
    let valid = parsed.get("valid").and_then(|v| v.as_bool()).unwrap_or(false);
    let code = parsed
        .get("code")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    Ok(LicenseVerifyLocalResult { valid, code })
}

#[cfg(test)]
mod tests {
    use super::parse_verify_stdout;

    #[test]
    fn parse_valid_verify_json() {
        let r = parse_verify_stdout("{\"valid\":true,\"tier\":\"pro\"}\n").unwrap();
        assert!(r.valid);
        assert!(r.code.is_none());
    }

    #[test]
    fn parse_invalid_verify_json() {
        let r = parse_verify_stdout("{\"valid\":false,\"code\":\"expired\"}\n").unwrap();
        assert!(!r.valid);
        assert_eq!(r.code.as_deref(), Some("expired"));
    }
}
