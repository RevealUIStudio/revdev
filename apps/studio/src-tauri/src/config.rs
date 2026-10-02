use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "bindings/")]
pub struct StudioConfig {
    pub intent: Option<String>,
    pub setup_complete: bool,
    pub completed_steps: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deploy: Option<DeployConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub develop: Option<DevelopConfig>,
    /// In-progress deploy wizard payload (tokens, generated secrets). Local config only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub wizard_draft: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "bindings/")]
pub struct DeployConfig {
    pub vercel_team_id: Option<String>,
    pub domain: Option<String>,
    pub apps: Option<DeployApps>,
    pub neon_project_id: Option<String>,
    pub email_provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "bindings/")]
pub struct DeployApps {
    pub api: Option<String>,
    pub admin: Option<String>,
    pub marketing: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "bindings/")]
pub struct DevelopConfig {
    pub repo_path: Option<String>,
    pub wsl_distro: Option<String>,
    pub nix_installed: bool,
}

impl Default for StudioConfig {
    fn default() -> Self {
        Self {
            intent: None,
            setup_complete: false,
            completed_steps: Vec::new(),
            deploy: None,
            develop: None,
            wizard_draft: None,
        }
    }
}

pub struct ConfigState {
    pub config: Mutex<StudioConfig>,
}

impl ConfigState {
    pub fn new() -> Self {
        let config = load_config().unwrap_or_default();
        Self {
            config: Mutex::new(config),
        }
    }
}

fn config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("revealui-studio").join("config.json")
}

fn load_config() -> Result<StudioConfig, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(StudioConfig::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

pub fn save_config(config: &StudioConfig) -> Result<(), String> {
    save_config_at(&config_path(), config)
}

fn save_config_at(path: &std::path::Path, config: &StudioConfig) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    crate::private_file::atomic_write_0600(path, &json)
}

/// Publish memory only after the complete replacement has been persisted.
pub fn commit_config(current: &mut StudioConfig, next: StudioConfig) -> Result<(), String> {
    commit_config_with(current, next, save_config)
}

fn commit_config_with(
    current: &mut StudioConfig,
    next: StudioConfig,
    persist: impl FnOnce(&StudioConfig) -> Result<(), String>,
) -> Result<(), String> {
    persist(&next)?;
    *current = next;
    Ok(())
}

#[cfg(test)]
mod persistence_tests {
    use super::*;

    fn configured(intent: &str) -> StudioConfig {
        StudioConfig {
            intent: Some(intent.to_string()),
            setup_complete: true,
            ..StudioConfig::default()
        }
    }
    #[test]
    fn rejected_set_and_reset_keep_committed_memory() {
        for next in [configured("next"), StudioConfig::default()] {
            let mut current = configured("committed");
            let before = serde_json::to_value(&current).unwrap();
            let result = commit_config_with(&mut current, next, |_| {
                Err("injected storage failure".into())
            });
            assert!(result.is_err());
            assert_eq!(serde_json::to_value(&current).unwrap(), before);
        }
    }
    #[test]
    fn accepted_set_and_reset_survive_reload() {
        let directory =
            std::env::temp_dir().join(format!("studio-config-test-{}", uuid::Uuid::new_v4()));
        let path = directory.join("config.json");
        let mut current = StudioConfig::default();
        for next in [configured("develop"), StudioConfig::default()] {
            let expected = serde_json::to_value(&next).unwrap();
            commit_config_with(&mut current, next, |config| save_config_at(&path, config)).unwrap();
            assert_eq!(serde_json::to_value(&current).unwrap(), expected);
            let restored: StudioConfig = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(serde_json::to_value(restored).unwrap(), expected);
        }
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn real_persistence_failure_keeps_memory_and_existing_bytes() {
        let directory =
            std::env::temp_dir().join(format!("studio-config-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let blocker = directory.join("config.json");
        fs::write(&blocker, b"existing committed bytes").unwrap();
        let mut current = configured("committed");
        let result = commit_config_with(&mut current, configured("rejected"), |config| {
            save_config_at(&blocker.join("child"), config)
        });
        assert!(result.is_err());
        assert_eq!(current.intent.as_deref(), Some("committed"));
        assert_eq!(fs::read(blocker).unwrap(), b"existing committed bytes");
        fs::remove_dir_all(directory).unwrap();
    }
}
