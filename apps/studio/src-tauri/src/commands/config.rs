use tauri::State;

use super::error::StudioError;
use crate::config::{commit_config, ConfigState, StudioConfig};

#[tauri::command]
pub fn get_config(state: State<ConfigState>) -> Result<StudioConfig, StudioError> {
    let config = state
        .config
        .lock()
        .map_err(|e| StudioError::LockPoisoned(e.to_string()))?;
    Ok(config.clone())
}

#[tauri::command]
pub fn set_config(state: State<ConfigState>, config: StudioConfig) -> Result<(), StudioError> {
    let mut current = state
        .config
        .lock()
        .map_err(|e| StudioError::LockPoisoned(e.to_string()))?;
    commit_config(&mut current, config).map_err(StudioError::Config)?;
    Ok(())
}

#[tauri::command]
pub fn reset_config(state: State<ConfigState>) -> Result<(), StudioError> {
    let default_config = StudioConfig::default();
    let mut current = state
        .config
        .lock()
        .map_err(|e| StudioError::LockPoisoned(e.to_string()))?;
    commit_config(&mut current, default_config).map_err(StudioError::Config)?;
    Ok(())
}
