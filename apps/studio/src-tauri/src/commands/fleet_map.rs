//! Read-only Fleet map: load planning tracker-snapshot + optional STATE.json.
//! Paths resolve under `$REVFLEET_HOME`, `$JV_REPO`, or `$HOME/revfleet` (WSL-first).

use std::fs;
use std::path::{Path, PathBuf};

use super::error::StudioError;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetMapPayload {
    pub jv_root: String,
    pub snapshot_path: String,
    pub state_path: Option<String>,
    pub snapshot: Value,
    pub state: Option<Value>,
    pub generated_at: Option<String>,
    pub free_surface_count: usize,
    pub initiative_count: usize,
    pub node_count: usize,
    pub edge_count: usize,
}

fn revfleet_home() -> PathBuf {
    if let Ok(p) = std::env::var("REVFLEET_HOME") {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            return pb;
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let pb = PathBuf::from(home).join("revfleet");
        if pb.is_dir() {
            return pb;
        }
    }
    // Windows-side layout when Studio runs on Windows host
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        let pb = PathBuf::from(userprofile).join("revfleet");
        if pb.is_dir() {
            return pb;
        }
    }
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join("revfleet")
}

fn planning_candidates(root: &Path) -> Vec<PathBuf> {
    // Dir names only — no private repo names in source.
    // Operators set JV_REPO for non-default layouts.
    vec![root.join(".jv")]
}

fn find_planning_root(fleet: &Path) -> Result<PathBuf, StudioError> {
    for c in planning_candidates(fleet) {
        let snap = c.join("docs").join("tracker-snapshot.json");
        if snap.is_file() {
            return Ok(c);
        }
    }
    if let Ok(jv) = std::env::var("JV_REPO") {
        let pb = PathBuf::from(jv);
        if pb.join("docs").join("tracker-snapshot.json").is_file() {
            return Ok(pb);
        }
    }
    Err(StudioError::Other(
        "tracker-snapshot.json not found — set JV_REPO or REVFLEET_HOME and run tracker sync in the planning checkout"
            .into(),
    ))
}

fn read_json(path: &Path) -> Result<Value, StudioError> {
    let text = fs::read_to_string(path)
        .map_err(|e| StudioError::Other(format!("read {}: {e}", path.display())))?;
    serde_json::from_str(&text)
        .map_err(|e| StudioError::Other(format!("parse {}: {e}", path.display())))
}

#[tauri::command]
pub fn read_fleet_map() -> Result<FleetMapPayload, StudioError> {
    let fleet = revfleet_home();
    let jv = find_planning_root(&fleet)?;
    let snapshot_path = jv.join("docs").join("tracker-snapshot.json");
    let snapshot = read_json(&snapshot_path)?;

    let generated_at = snapshot
        .get("generatedAt")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let free_surface_count = snapshot
        .get("freeSurfaces")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let initiative_count = snapshot
        .get("initiatives")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let node_count = snapshot
        .get("nodes")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let edge_count = snapshot
        .get("edges")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    let state_path = jv.join("docs").join(".generated").join("STATE.json");
    let (state, state_path_str) = if state_path.is_file() {
        (
            Some(read_json(&state_path)?),
            Some(state_path.display().to_string()),
        )
    } else {
        (None, None)
    };

    Ok(FleetMapPayload {
        jv_root: jv.display().to_string(),
        snapshot_path: snapshot_path.display().to_string(),
        state_path: state_path_str,
        snapshot,
        state,
        generated_at,
        free_surface_count,
        initiative_count,
        node_count,
        edge_count,
    })
}
