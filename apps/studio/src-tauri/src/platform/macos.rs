use std::process::Command;

use super::trait_defs::{
    AppStatus, MountStatus, PlatformOps, SetupStatus, SyncResult, SystemStatus,
};

/// macOS implementation — WSL-specific features unsupported; git runs natively.
pub struct MacPlatform;

impl MacPlatform {
    pub fn new() -> Self {
        Self
    }
}

impl PlatformOps for MacPlatform {
    fn get_system_status(&self) -> Result<SystemStatus, String> {
        Ok(SystemStatus {
            wsl_running: false,
            distribution: "native".to_string(),
            tier: "unknown".to_string(),
            systemd_status: "n/a".to_string(),
        })
    }

    fn get_mount_status(&self) -> Result<MountStatus, String> {
        Ok(MountStatus {
            mounted: false,
            mount_point: "/mnt/wsl-dev".to_string(),
            device: None,
            size_total: None,
            size_used: None,
            size_available: None,
            use_percent: None,
        })
    }

    fn mount_devbox(&self) -> Result<String, String> {
        Err("DevPod mount requires Windows/WSL".to_string())
    }

    fn unmount_devbox(&self) -> Result<String, String> {
        Err("DevPod unmount requires Windows/WSL".to_string())
    }

    fn sync_all_repos(&self) -> Result<Vec<SyncResult>, String> {
        Err("Repo sync requires Windows/WSL".to_string())
    }

    fn sync_repo(&self, _name: &str) -> Result<SyncResult, String> {
        Err("Repo sync requires Windows/WSL".to_string())
    }

    fn list_apps(&self) -> Result<Vec<AppStatus>, String> {
        Ok(vec![])
    }

    fn start_app(&self, _name: &str) -> Result<String, String> {
        Err("App launcher requires Windows/WSL".to_string())
    }

    fn stop_app(&self, _name: &str) -> Result<String, String> {
        Err("App launcher requires Windows/WSL".to_string())
    }

    fn check_setup(&self) -> Result<SetupStatus, String> {
        let git_name = Command::new("git")
            .args(["config", "--global", "user.name"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();

        let git_email = Command::new("git")
            .args(["config", "--global", "user.email"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();

        let nix_installed = Command::new("nix")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        Ok(SetupStatus {
            wsl_running: false,
            nix_installed,
            devbox_mounted: false,
            git_name,
            git_email,
        })
    }

    fn set_git_identity(&self, name: &str, email: &str) -> Result<(), String> {
        Command::new("git")
            .args(["config", "--global", "user.name", name])
            .output()
            .map_err(|e| format!("git config failed: {e}"))?;

        Command::new("git")
            .args(["config", "--global", "user.email", email])
            .output()
            .map_err(|e| format!("git config failed: {e}"))?;

        Ok(())
    }

}
