use std::process::Command;

use serde::Serialize;
use ts_rs::TS;

// ── Types ───────────────────────────────────────────────────────────

/// Status of the Ollama server.
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct OllamaStatus {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
}

/// An Ollama model available locally.
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct OllamaModel {
    pub name: String,
    pub size: String,
    pub modified: String,
}

/// Result of pulling a model.
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct ModelPullResult {
    pub success: bool,
    pub message: String,
}

// ── Ollama ──────────────────────────────────────────────────────────

/// Check if Ollama is installed and running.
pub fn ollama_status() -> OllamaStatus {
    // Check if ollama binary exists
    let installed = Command::new("which")
        .arg("ollama")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !installed {
        return OllamaStatus {
            installed: false,
            running: false,
            version: None,
        };
    }

    // Get version
    let version = Command::new("ollama")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string())
            } else {
                None
            }
        });

    // Check if running by listing models (succeeds only when server is up)
    let running = Command::new("ollama")
        .arg("list")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    OllamaStatus {
        installed,
        running,
        version,
    }
}

/// List locally available Ollama models.
pub fn ollama_list_models() -> Result<Vec<OllamaModel>, String> {
    let output = Command::new("ollama")
        .arg("list")
        .output()
        .map_err(|e| format!("Failed to run ollama list: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ollama list failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let models: Vec<OllamaModel> = stdout
        .lines()
        .skip(1) // Skip header row
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                Some(OllamaModel {
                    name: parts[0].to_string(),
                    size: parts.get(2).unwrap_or(&"").to_string(),
                    modified: parts[3..].join(" "),
                })
            } else {
                None
            }
        })
        .collect();

    Ok(models)
}

/// Pull (download) an Ollama model.
pub fn ollama_pull(model_name: &str) -> Result<ModelPullResult, String> {
    let output = Command::new("ollama")
        .arg("pull")
        .arg(model_name)
        .output()
        .map_err(|e| format!("Failed to run ollama pull: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(ModelPullResult {
            success: true,
            message: if stdout.is_empty() { stderr } else { stdout },
        })
    } else {
        Ok(ModelPullResult {
            success: false,
            message: stderr,
        })
    }
}

/// Delete a locally downloaded Ollama model.
pub fn ollama_delete(model_name: &str) -> Result<(), String> {
    let output = Command::new("ollama")
        .arg("rm")
        .arg(model_name)
        .output()
        .map_err(|e| format!("Failed to run ollama rm: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("ollama rm failed: {stderr}"))
    }
}

/// Start the Ollama server in the background.
pub fn ollama_start() -> Result<(), String> {
    Command::new("ollama")
        .arg("serve")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start ollama serve: {e}"))?;

    Ok(())
}

/// Stop the Ollama server.
pub fn ollama_stop() -> Result<(), String> {
    // Ollama doesn't have a built-in stop command, use pkill
    let output = Command::new("pkill")
        .arg("-f")
        .arg("ollama serve")
        .output()
        .map_err(|e| format!("Failed to stop ollama: {e}"))?;

    if output.status.success() || output.status.code() == Some(1) {
        // code 1 = no processes matched, which is fine
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("pkill failed: {stderr}"))
    }
}

// ── Inference Snaps ─────────────────────────────────────────────────

/// Status of a Canonical inference snap.
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct SnapStatus {
    pub installed: bool,
    pub running: bool,
    pub snap_name: String,
    pub endpoint: Option<String>,
    pub version: Option<String>,
}

/// An available inference snap model.
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct SnapModel {
    pub name: String,
    pub description: String,
    pub installed: bool,
}

/// Product Inference Snaps catalog (US-origin allowlist only).
/// Lockstep with `@revealui/ai` `US_ORIGIN_INFERENCE_SNAP_IDS`.
const KNOWN_SNAPS: &[(&str, &str)] = &[
    ("nemotron-3-nano", "NVIDIA (US) — general + tools; product default"),
    ("nemotron-3-nano-omni", "NVIDIA (US) — multimodal (text/image/video/audio)"),
    ("gemma4", "Google (US) — general + vision + tools"),
    ("gemma3", "Google (US) — general + vision (allowlisted)"),
];

/// Check if a specific inference snap is installed and running.
pub fn snap_status(snap_name: &str) -> SnapStatus {
    // Check if the snap is installed
    let installed = Command::new("snap")
        .args(["list", snap_name])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !installed {
        return SnapStatus {
            installed: false,
            running: false,
            snap_name: snap_name.to_string(),
            endpoint: None,
            version: None,
        };
    }

    // Get version from snap list output
    let version = Command::new("snap")
        .args(["list", snap_name])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                // Second line, second column is the version
                stdout.lines().nth(1).and_then(|line| {
                    line.split_whitespace().nth(1).map(|v| v.to_string())
                })
            } else {
                None
            }
        });

    // Check if the snap's HTTP endpoint is responding
    let endpoint = format!("http://localhost:9090/v1");
    let running = Command::new(snap_name)
        .arg("status")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    SnapStatus {
        installed,
        running,
        snap_name: snap_name.to_string(),
        endpoint: if running { Some(endpoint) } else { None },
        version,
    }
}

/// List all known inference snaps with their install status.
pub fn snap_list_models() -> Vec<SnapModel> {
    KNOWN_SNAPS
        .iter()
        .map(|(name, desc)| {
            let installed = Command::new("snap")
                .args(["list", name])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            SnapModel {
                name: name.to_string(),
                description: desc.to_string(),
                installed,
            }
        })
        .collect()
}

/// Install an inference snap.
pub fn snap_install(snap_name: &str) -> Result<ModelPullResult, String> {
    // Validate the snap name is one of our known snaps
    if !KNOWN_SNAPS.iter().any(|(name, _)| *name == snap_name) {
        return Err(format!("Unknown inference snap: {snap_name}"));
    }

    let output = Command::new("sudo")
        .args(["snap", "install", snap_name])
        .output()
        .map_err(|e| format!("Failed to run snap install: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(ModelPullResult {
            success: true,
            message: if stdout.is_empty() { stderr } else { stdout },
        })
    } else {
        Ok(ModelPullResult {
            success: false,
            message: stderr,
        })
    }
}

/// Remove an inference snap.
pub fn snap_remove(snap_name: &str) -> Result<(), String> {
    let output = Command::new("sudo")
        .args(["snap", "remove", snap_name])
        .output()
        .map_err(|e| format!("Failed to run snap remove: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("snap remove failed: {stderr}"))
    }
}


// ── Local AI profile tiers (lockstep harnesses InferenceService + @revealui/ai) ─

use std::fs;
use std::path::PathBuf;

/// Resource tier for host local AI (idle frees RAM for IDE).
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LocalAiProfileView {
    pub tier: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub ollama_models_dir: Option<String>,
    pub keep_alive: Option<String>,
    pub updated_at: String,
    pub note: Option<String>,
    pub mem_available_gib: Option<f64>,
    pub ollama_running: bool,
    pub snaps_running: Vec<String>,
}

fn profile_json_path() -> PathBuf {
    if let Ok(p) = std::env::var("REVEALUI_INFERENCE_PROFILE_PATH") {
        return PathBuf::from(p);
    }
    dirs_next_home()
        .join(".local")
        .join("share")
        .join("revealui")
        .join("inference-profile.json")
}

fn active_env_path() -> PathBuf {
    dirs_next_home()
        .join(".config")
        .join("revealui")
        .join("local-ai.active.env")
}

fn dirs_next_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn hot_ollama_dir() -> String {
    if let Ok(p) = std::env::var("OLLAMA_MODELS") {
        return p;
    }
    let studio = PathBuf::from("/mnt/studio/models/ollama");
    if studio.exists() {
        return studio.to_string_lossy().into_owned();
    }
    dirs_next_home()
        .join(".ollama")
        .join("models")
        .to_string_lossy()
        .into_owned()
}

fn read_mem_available_gib() -> Option<f64> {
    let text = fs::read_to_string("/proc/meminfo").ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("MemAvailable:") {
            let kb: f64 = rest
                .chars()
                .filter(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .ok()?;
            return Some(((kb / 1024.0 / 1024.0) * 10.0).round() / 10.0);
        }
    }
    None
}

fn parse_snap_openai_url(status: &str) -> Option<String> {
    for line in status.lines() {
        let lower = line.to_lowercase();
        if let Some(idx) = lower.find("openai:") {
            let after = line[idx + "openai:".len()..].trim();
            let url = after.split_whitespace().next()?;
            if url.starts_with("http") {
                return Some(url.to_string());
            }
        }
    }
    None
}

fn empty_idle_profile_json() -> serde_json::Value {
    serde_json::json!({
        "tier": "idle",
        "provider": null,
        "model": null,
        "baseURL": null,
        "ollamaModelsDir": hot_ollama_dir(),
        "keepAlive": "0",
        "updatedAt": chrono_like_now(),
        "note": "AI stopped — IDE/dev headroom",
    })
}

fn chrono_like_now() -> String {
    // RFC3339-ish without extra deps: use `date -Iseconds` when available
    Command::new("date")
        .arg("-u")
        .arg("+%Y-%m-%dT%H:%M:%SZ")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".into())
}

fn save_profile(profile: &serde_json::Value) -> Result<(), String> {
    let path = profile_json_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir profile dir: {e}"))?;
    }
    let body = serde_json::to_string_pretty(profile).map_err(|e| e.to_string())?;
    fs::write(&path, format!("{body}\n")).map_err(|e| format!("write profile: {e}"))?;

    let env_path = active_env_path();
    if let Some(parent) = env_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir env dir: {e}"))?;
    }
    let tier = profile
        .get("tier")
        .and_then(|v| v.as_str())
        .unwrap_or("idle");
    let updated = profile
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut lines = vec![
        format!("# generated by Studio InferenceService.profileApply {updated}"),
        format!("export REVEALUI_LOCAL_AI_TIER={tier}"),
    ];
    if let Some(dir) = profile.get("ollamaModelsDir").and_then(|v| v.as_str()) {
        lines.push(format!("export OLLAMA_MODELS={dir}"));
    }
    if let Some(ka) = profile.get("keepAlive") {
        if ka.is_null() {
            // skip
        } else if let Some(s) = ka.as_str() {
            lines.push(format!("export OLLAMA_KEEP_ALIVE={s}"));
        }
    }
    match profile.get("provider").and_then(|v| v.as_str()) {
        Some(p) => lines.push(format!("export LLM_PROVIDER={p}")),
        None => lines.push("unset LLM_PROVIDER".into()),
    }
    match profile.get("model").and_then(|v| v.as_str()) {
        Some(m) => lines.push(format!("export LLM_MODEL={m}")),
        None => lines.push("unset LLM_MODEL".into()),
    }
    let provider = profile.get("provider").and_then(|v| v.as_str());
    let base = profile.get("baseURL").and_then(|v| v.as_str());
    if provider == Some("inference-snaps") {
        if let Some(b) = base {
            lines.push(format!("export INFERENCE_SNAPS_BASE_URL={b}"));
        } else {
            lines.push("unset INFERENCE_SNAPS_BASE_URL".into());
        }
    } else {
        lines.push("unset INFERENCE_SNAPS_BASE_URL".into());
    }
    if provider == Some("ollama") {
        if let Some(b) = base {
            lines.push(format!("export OLLAMA_BASE_URL={b}"));
        }
    }
    fs::write(&env_path, format!("{}\n", lines.join("\n")))
        .map_err(|e| format!("write active env: {e}"))?;
    Ok(())
}

fn load_profile_json() -> serde_json::Value {
    let path = profile_json_path();
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if v.get("tier").and_then(|t| t.as_str()).is_some() {
                return v;
            }
        }
    }
    empty_idle_profile_json()
}

fn stop_all_product_snaps(disable_boot: bool) {
    for (name, _) in KNOWN_SNAPS {
        let installed = Command::new("snap")
            .args(["list", name])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !installed {
            continue;
        }
        let mut args = vec!["snap", "stop"];
        if disable_boot {
            args.push("--disable");
        }
        args.push(name);
        let _ = Command::new("sudo").args(&args).output();
    }
}

fn snap_endpoint(snap_name: &str) -> Option<String> {
    let output = Command::new(snap_name).arg("status").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_snap_openai_url(&stdout).or_else(|| Some("http://127.0.0.1:9090/v1".into()))
}

fn start_snap(snap_name: &str) -> Result<(), String> {
    let installed = Command::new("snap")
        .args(["list", snap_name])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !installed {
        return Err(format!(
            "Snap {snap_name} is not installed. Install: sudo snap install {snap_name}"
        ));
    }
    let _ = Command::new("sudo")
        .args(["snap", "start", "--enable", snap_name])
        .output();
    let _ = Command::new("sudo")
        .args(["snap", "start", snap_name])
        .output();
    if snap_name == "gemma3" {
        let _ = Command::new("bash")
            .args(["-c", "yes | sudo timeout 45 gemma3 use-model 270m || true"])
            .output();
    }
    Ok(())
}

fn wait_snap_endpoint(snap_name: &str) -> Option<String> {
    for _ in 0..30 {
        if let Some(ep) = snap_endpoint(snap_name) {
            return Some(ep);
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    None
}

fn value_to_view(profile: &serde_json::Value) -> LocalAiProfileView {
    let ollama = ollama_status();
    let mut snaps_running = Vec::new();
    for (name, _) in KNOWN_SNAPS {
        let st = snap_status(name);
        if st.running {
            snaps_running.push((*name).to_string());
        }
    }
    LocalAiProfileView {
        tier: profile
            .get("tier")
            .and_then(|v| v.as_str())
            .unwrap_or("idle")
            .to_string(),
        provider: profile
            .get("provider")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        model: profile
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        base_url: profile
            .get("baseURL")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        ollama_models_dir: profile
            .get("ollamaModelsDir")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        keep_alive: profile
            .get("keepAlive")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        updated_at: profile
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        note: profile
            .get("note")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        mem_available_gib: read_mem_available_gib(),
        ollama_running: ollama.running,
        snaps_running,
    }
}

/// Read local AI profile + live engine status.
pub fn profile_get() -> LocalAiProfileView {
    value_to_view(&load_profile_json())
}

/// Apply a resource tier (idle | daily | snaps | heavy). Writes profile JSON + shell env.
pub fn profile_apply(tier: &str) -> Result<LocalAiProfileView, String> {
    let tier = tier.trim().to_lowercase();
    if !matches!(tier.as_str(), "idle" | "daily" | "snaps" | "heavy") {
        return Err(format!(
            "Unknown tier '{tier}'. Use idle|daily|snaps|heavy"
        ));
    }

    let mut profile = empty_idle_profile_json();
    let now = chrono_like_now();
    profile["updatedAt"] = serde_json::json!(now);
    profile["tier"] = serde_json::json!(tier);

    match tier.as_str() {
        "idle" => {
            let _ = ollama_stop();
            stop_all_product_snaps(true);
            profile["provider"] = serde_json::Value::Null;
            profile["model"] = serde_json::Value::Null;
            profile["baseURL"] = serde_json::Value::Null;
            profile["keepAlive"] = serde_json::json!("0");
            profile["note"] = serde_json::json!("AI stopped — IDE/dev headroom");
        }
        "daily" => {
            stop_all_product_snaps(true);
            ollama_start()?;
            for _ in 0..20 {
                if ollama_status().running {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            profile["provider"] = serde_json::json!("ollama");
            profile["model"] = serde_json::json!("gemma3:1b");
            profile["baseURL"] = serde_json::json!("http://127.0.0.1:11434");
            profile["keepAlive"] = serde_json::json!("0");
            profile["note"] =
                serde_json::json!("Ollama small US model; weights unload after each request");
        }
        "snaps" => {
            let _ = ollama_stop();
            let snap_name = "gemma3";
            start_snap(snap_name)?;
            let endpoint = wait_snap_endpoint(snap_name);
            profile["provider"] = serde_json::json!("inference-snaps");
            profile["model"] = serde_json::json!(snap_name);
            profile["baseURL"] = match endpoint {
                Some(ep) => serde_json::json!(ep),
                None => serde_json::Value::Null,
            };
            profile["keepAlive"] = serde_json::Value::Null;
            profile["note"] =
                serde_json::json!("Inference Snap product path (US-origin allowlist)");
        }
        "heavy" => {
            let _ = ollama_stop();
            for (name, _) in KNOWN_SNAPS {
                if *name == "nemotron-3-nano" {
                    continue;
                }
                let _ = Command::new("sudo")
                    .args(["snap", "stop", "--disable", name])
                    .output();
            }
            let snap_name = "nemotron-3-nano";
            start_snap(snap_name)?;
            let endpoint = wait_snap_endpoint(snap_name);
            let mem = read_mem_available_gib();
            let note = match mem {
                Some(m) if m < 6.0 => format!(
                    "Heavy snap on ~{m}Gi available RAM — expect thrash; prefer daily/snaps for IDE work"
                ),
                _ => "Heavy snap — needs substantial RAM".into(),
            };
            profile["provider"] = serde_json::json!("inference-snaps");
            profile["model"] = serde_json::json!(snap_name);
            profile["baseURL"] = match endpoint {
                Some(ep) => serde_json::json!(ep),
                None => serde_json::Value::Null,
            };
            profile["keepAlive"] = serde_json::Value::Null;
            profile["note"] = serde_json::json!(note);
        }
        _ => unreachable!(),
    }

    save_profile(&profile)?;
    Ok(value_to_view(&profile))
}
