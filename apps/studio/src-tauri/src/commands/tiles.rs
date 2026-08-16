//! Trusted-host tile helpers: browser profile discovery and process listing.
//! These replace frontend `shell:allow-execute` / `Command.create('exec-sh')`.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

use super::error::StudioError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    pub directory: String,
    pub name: String,
    /// `"chrome"` or `"edge"`
    pub browser: String,
}

/// Detect Chrome/Edge user profiles by reading Preferences under known data dirs.
#[tauri::command]
pub fn detect_browser_profiles() -> Result<Vec<BrowserProfile>, StudioError> {
    let mut profiles = Vec::new();
    for (browser, base) in browser_data_dirs() {
        if !base.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&base) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let dir_name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if dir_name != "Default" && !dir_name.starts_with("Profile ") {
                continue;
            }
            if !path.is_dir() {
                continue;
            }
            let prefs_path = path.join("Preferences");
            let Ok(raw) = fs::read_to_string(&prefs_path) else {
                continue;
            };
            let Ok(prefs) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let Some(name) = prefs
                .get("profile")
                .and_then(|p| p.get("name"))
                .and_then(|n| n.as_str())
            else {
                continue;
            };
            if name.is_empty() {
                continue;
            }
            profiles.push(BrowserProfile {
                directory: dir_name,
                name: name.to_string(),
                browser: browser.to_string(),
            });
        }
    }
    Ok(profiles)
}

/// Return running process names (best-effort) for tile "running" indicators.
/// On Linux/WSL this includes `ps -eo comm` plus Windows `tasklist` when available.
#[tauri::command]
pub fn list_running_processes() -> Result<Vec<String>, StudioError> {
    let mut names = Vec::new();

    // Native process list (Linux/macOS/Windows host).
    if let Ok(output) = native_process_list() {
        names.extend(parse_process_names(&output));
    }

    // When Studio runs under WSL/Linux, also sample Windows processes.
    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = Command::new("tasklist.exe")
            .args(["/FO", "CSV", "/NH"])
            .output()
        {
            if output.status.success() {
                names.extend(parse_tasklist_csv(&String::from_utf8_lossy(&output.stdout)));
            }
        }
    }

    Ok(names)
}

fn native_process_list() -> Result<String, StudioError> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("tasklist.exe");
        crate::win_process::hide_std(&mut cmd);
        let output = cmd
            .args(["/FO", "CSV", "/NH"])
            .output()
            .map_err(|e| StudioError::Process(e.to_string()))?;
        if !output.status.success() {
            return Err(StudioError::Process("tasklist failed".into()));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("ps")
            .args(["-eo", "comm"])
            .output()
            .map_err(|e| StudioError::Process(e.to_string()))?;
        if !output.status.success() {
            return Err(StudioError::Process("ps failed".into()));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

fn parse_process_names(raw: &str) -> Vec<String> {
    // CSV tasklist on Windows: "Image Name","PID",...
    if raw.contains("\",\"") || raw.lines().next().map(|l| l.starts_with('"')).unwrap_or(false) {
        return parse_tasklist_csv(raw);
    }
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && *l != "COMMAND" && *l != "COMM")
        .map(|l| l.to_string())
        .collect()
}

fn parse_tasklist_csv(raw: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // "name.exe","1234",...
        if let Some(rest) = line.strip_prefix('"') {
            if let Some(end) = rest.find('"') {
                names.push(rest[..end].to_string());
            }
        }
    }
    names
}

fn browser_data_dirs() -> Vec<(&'static str, PathBuf)> {
    let mut dirs = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            let base = PathBuf::from(profile);
            dirs.push((
                "chrome",
                base.join("AppData/Local/Google/Chrome/User Data"),
            ));
            dirs.push((
                "edge",
                base.join("AppData/Local/Microsoft/Edge/User Data"),
            ));
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = home_dir() {
            dirs.push((
                "chrome",
                home.join("Library/Application Support/Google/Chrome"),
            ));
            dirs.push((
                "edge",
                home.join("Library/Application Support/Microsoft Edge"),
            ));
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Native Linux Chromium paths
        if let Some(home) = home_dir() {
            dirs.push(("chrome", home.join(".config/google-chrome")));
            dirs.push(("edge", home.join(".config/microsoft-edge")));
        }
        // WSL: Windows browser profiles via /mnt/<drive>/Users/...
        if let Some(win_home) = wsl_windows_userprofile() {
            dirs.push((
                "chrome",
                win_home.join("AppData/Local/Google/Chrome/User Data"),
            ));
            dirs.push((
                "edge",
                win_home.join("AppData/Local/Microsoft/Edge/User Data"),
            ));
        }
    }

    dirs
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Resolve Windows %USERPROFILE% from WSL and map to `/mnt/<drive>/...`.
#[cfg(target_os = "linux")]
fn wsl_windows_userprofile() -> Option<PathBuf> {
    let output = Command::new("cmd.exe")
        .args(["/c", "echo %USERPROFILE%"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let win = String::from_utf8_lossy(&output.stdout)
        .trim()
        .trim_end_matches('\r')
        .to_string();
    if win.is_empty() || win.contains('%') {
        return None;
    }
    windows_path_to_wsl(&win)
}

#[cfg(target_os = "linux")]
fn windows_path_to_wsl(win: &str) -> Option<PathBuf> {
    // C:\Users\name → /mnt/c/Users/name
    let bytes = win.as_bytes();
    if bytes.len() < 3 || bytes[1] != b':' || (bytes[2] != b'\\' && bytes[2] != b'/') {
        return None;
    }
    let drive = (bytes[0] as char).to_ascii_lowercase();
    if !drive.is_ascii_alphabetic() {
        return None;
    }
    let rest = win[3..].replace('\\', "/");
    Some(PathBuf::from(format!("/mnt/{drive}/{rest}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ps_comm_lines() {
        let names = parse_process_names("COMMAND\nzed\ntmux\nchrome\n");
        assert!(names.contains(&"zed".into()));
        assert!(names.contains(&"tmux".into()));
        assert!(!names.iter().any(|n| n == "COMMAND"));
    }

    #[test]
    fn parse_tasklist_image_names() {
        let raw = "\"chrome.exe\",\"1234\",\"Console\",\"1\",\"100 K\"\r\n\"Zed.exe\",\"99\",\"Console\",\"1\",\"50 K\"\r\n";
        let names = parse_tasklist_csv(raw);
        assert_eq!(names, vec!["chrome.exe".to_string(), "Zed.exe".to_string()]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn maps_windows_userprofile() {
        let p = windows_path_to_wsl(r"C:\Users\josh").unwrap();
        assert_eq!(p, PathBuf::from("/mnt/c/Users/josh"));
    }
}
