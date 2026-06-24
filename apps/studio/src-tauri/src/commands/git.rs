//! Git + file commands for the Studio editor.
//!
//! Zero-9P (ADR 2026-06-23, P2): every operation routes through the WSL-side
//! daemon over `harness::repo_rpc`, so NO Windows process performs file or git
//! I/O on an ext4 project path through the 9P redirector. The daemon owns all
//! file/git I/O; this module is a thin typed adapter that maps the daemon's
//! JSON responses onto the Tauri return contracts the frontend already binds.

use serde::Serialize;
use serde_json::{json, Value};
use ts_rs::TS;

use super::error::StudioError;
use crate::harness;

// ── Branch / push / pull / log types ────────────────────────────────────────

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct GitPushResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct GitPullResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct GitCommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub message: String,
    pub author: String,
    pub timestamp: i64, // Unix seconds
}

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct GitFileEntry {
    pub path: String,
    /// One of: "modified" | "new" | "deleted" | "renamed" | "untracked" | "conflicted"
    pub status: String,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct GitStatusResult {
    pub branch: String,
    pub staged: Vec<GitFileEntry>,
    pub unstaged: Vec<GitFileEntry>,
    pub untracked: Vec<GitFileEntry>,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Daemon git.*/file.* mutation handlers report failure as `{ success: false,
/// error }` in the RESULT (not a JSON-RPC error). Surface that as an error so a
/// failed stage/commit/etc. doesn't read as success.
fn require_success(v: &Value) -> Result<(), StudioError> {
    if v.get("success").and_then(Value::as_bool) == Some(false) {
        let msg = v
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("git operation failed");
        return Err(StudioError::Other(msg.to_string()));
    }
    Ok(())
}

/// Map one porcelain status char (X = index side, Y = worktree side) to the
/// frontend's friendly status string.
fn map_status_char(code: u8) -> &'static str {
    match code {
        b'A' | b'C' => "new",
        b'D' => "deleted",
        b'R' => "renamed",
        _ => "modified", // M, T, and any other change
    }
}

/// Read a git blob (HEAD or index) via the daemon. `None` when the path is not
/// present in that tree (or is too large) — the diff viewer treats that as an
/// empty side, matching the previous git2 behavior.
async fn read_blob(repo_path: &str, file_path: &str, method: &str) -> Option<String> {
    let v = harness::repo_rpc(method, repo_path, json!({ "filePath": file_path }))
        .await
        .ok()?;
    if v.get("success").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    if v.get("tooLarge").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    v.get("content").and_then(Value::as_str).map(str::to_string)
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Return the current branch, staged/unstaged/untracked file lists.
#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<GitStatusResult, StudioError> {
    let v = harness::repo_rpc("git.status", &repo_path, json!({}))
        .await
        .map_err(StudioError::Other)?;
    require_success(&v)?;

    let branch = v
        .get("branch")
        .and_then(Value::as_str)
        .unwrap_or("HEAD")
        .to_string();

    let (staged, unstaged, untracked) = bucket_porcelain(
        v.get("files")
            .and_then(Value::as_array)
            .unwrap_or(&Vec::new()),
    );
    Ok(GitStatusResult {
        branch,
        staged,
        unstaged,
        untracked,
    })
}

/// Sort the daemon's `git.status` entries (each `{ path, status: "XY" }`, where
/// X is the index side and Y the worktree side of porcelain v1) into the
/// staged / unstaged / untracked buckets the frontend renders.
fn bucket_porcelain(files: &[Value]) -> (Vec<GitFileEntry>, Vec<GitFileEntry>, Vec<GitFileEntry>) {
    let mut staged: Vec<GitFileEntry> = Vec::new();
    let mut unstaged: Vec<GitFileEntry> = Vec::new();
    let mut untracked: Vec<GitFileEntry> = Vec::new();

    for f in files {
        let path = f
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let st = f.get("status").and_then(Value::as_str).unwrap_or("  ");
        let bytes = st.as_bytes();
        let x = bytes.first().copied().unwrap_or(b' ');
        let y = bytes.get(1).copied().unwrap_or(b' ');

        if x == b'?' && y == b'?' {
            untracked.push(GitFileEntry {
                path,
                status: "untracked".to_string(),
            });
            continue;
        }
        // Unmerged paths: any 'U', or both-added / both-deleted.
        if x == b'U' || y == b'U' || (x == b'D' && y == b'D') || (x == b'A' && y == b'A') {
            unstaged.push(GitFileEntry {
                path,
                status: "conflicted".to_string(),
            });
            continue;
        }
        if x != b' ' {
            staged.push(GitFileEntry {
                path: path.clone(),
                status: map_status_char(x).to_string(),
            });
        }
        if y != b' ' {
            unstaged.push(GitFileEntry {
                path,
                status: map_status_char(y).to_string(),
            });
        }
    }

    (staged, unstaged, untracked)
}

/// Return a unified-diff patch for a single file.
/// - `staged = true`:  diff HEAD → index (what will be committed)
/// - `staged = false`: diff index → worktree (unstaged changes)
#[tauri::command]
pub async fn git_diff_file(
    repo_path: String,
    file_path: String,
    staged: bool,
) -> Result<String, StudioError> {
    let v = harness::repo_rpc(
        "git.diffFile",
        &repo_path,
        json!({ "filePath": file_path, "staged": staged }),
    )
    .await
    .map_err(StudioError::Other)?;
    require_success(&v)?;
    Ok(v.get("diff")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

/// Stage a file (add to index). Handles deleted files too (`git add` records
/// the deletion).
#[tauri::command]
pub async fn git_stage_file(repo_path: String, file_path: String) -> Result<(), StudioError> {
    let v = harness::repo_rpc(
        "git.stageFile",
        &repo_path,
        json!({ "filePath": file_path }),
    )
    .await
    .map_err(StudioError::Other)?;
    require_success(&v)
}

/// Unstage a file (restore the index entry from HEAD).
#[tauri::command]
pub async fn git_unstage_file(repo_path: String, file_path: String) -> Result<(), StudioError> {
    let v = harness::repo_rpc(
        "git.unstageFile",
        &repo_path,
        json!({ "filePath": file_path }),
    )
    .await
    .map_err(StudioError::Other)?;
    require_success(&v)
}

/// Discard working-tree changes to a file by restoring it from the index.
#[tauri::command]
pub async fn git_discard_file(repo_path: String, file_path: String) -> Result<(), StudioError> {
    let v = harness::repo_rpc(
        "git.discardFile",
        &repo_path,
        json!({ "filePath": file_path }),
    )
    .await
    .map_err(StudioError::Other)?;
    require_success(&v)
}

/// List all local branches. The currently checked-out branch has `is_current = true`.
#[tauri::command]
pub async fn git_list_branches(repo_path: String) -> Result<Vec<GitBranch>, StudioError> {
    let v = harness::repo_rpc("git.listBranches", &repo_path, json!({}))
        .await
        .map_err(StudioError::Other)?;
    require_success(&v)?;
    let current = v.get("current").and_then(Value::as_str);
    let branches = v
        .get("branches")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|name| GitBranch {
                    name: name.to_string(),
                    is_current: Some(name) == current,
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(branches)
}

/// Create a new local branch from the current HEAD (does not switch to it).
#[tauri::command]
pub async fn git_create_branch(repo_path: String, name: String) -> Result<(), StudioError> {
    let v = harness::repo_rpc("git.createBranch", &repo_path, json!({ "name": name }))
        .await
        .map_err(StudioError::Other)?;
    require_success(&v)
}

/// Switch the working tree to an existing local branch.
#[tauri::command]
pub async fn git_switch_branch(repo_path: String, name: String) -> Result<(), StudioError> {
    let v = harness::repo_rpc("git.switchBranch", &repo_path, json!({ "name": name }))
        .await
        .map_err(StudioError::Other)?;
    require_success(&v)
}

/// Delete a local branch. Force-deletes to preserve the prior git2 behavior
/// (which removed the ref regardless of merge state).
#[tauri::command]
pub async fn git_delete_branch(repo_path: String, name: String) -> Result<(), StudioError> {
    let v = harness::repo_rpc(
        "git.deleteBranch",
        &repo_path,
        json!({ "name": name, "force": true }),
    )
    .await
    .map_err(StudioError::Other)?;
    require_success(&v)
}

/// Push a branch to a remote (the daemon shells the system `git`, inheriting
/// the WSL-side SSH agent / credential store).
#[tauri::command]
pub async fn git_push(
    repo_path: String,
    remote: String,
    branch: String,
) -> Result<GitPushResult, StudioError> {
    let v = harness::repo_rpc(
        "git.push",
        &repo_path,
        json!({ "remote": remote, "branch": branch }),
    )
    .await
    .map_err(StudioError::Other)?;
    let success = v.get("success").and_then(Value::as_bool).unwrap_or(false);
    let message = if success {
        v.get("stdout").and_then(Value::as_str).unwrap_or("")
    } else {
        v.get("error")
            .and_then(Value::as_str)
            .unwrap_or("git push failed")
    }
    .trim()
    .to_string();
    Ok(GitPushResult { success, message })
}

/// Pull from a remote (daemon shells the system `git`).
#[tauri::command]
pub async fn git_pull(
    repo_path: String,
    remote: String,
    branch: String,
) -> Result<GitPullResult, StudioError> {
    let v = harness::repo_rpc(
        "git.pull",
        &repo_path,
        json!({ "remote": remote, "branch": branch }),
    )
    .await
    .map_err(StudioError::Other)?;
    let success = v.get("success").and_then(Value::as_bool).unwrap_or(false);
    let message = if success {
        v.get("stdout").and_then(Value::as_str).unwrap_or("")
    } else {
        v.get("error")
            .and_then(Value::as_str)
            .unwrap_or("git pull failed")
    }
    .trim()
    .to_string();
    Ok(GitPullResult { success, message })
}

/// Return the last `limit` commits on the current branch (default 50).
#[tauri::command]
pub async fn git_log(
    repo_path: String,
    limit: Option<u32>,
) -> Result<Vec<GitCommitInfo>, StudioError> {
    let mut params = json!({});
    if let Some(l) = limit {
        params["limit"] = json!(l);
    }
    let v = harness::repo_rpc("git.log", &repo_path, params)
        .await
        .map_err(StudioError::Other)?;
    require_success(&v)?;
    let commits = v
        .get("commits")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let sha = c.get("hash").and_then(Value::as_str)?.to_string();
                    let short_sha = sha.get(..7).unwrap_or(&sha).to_string();
                    Some(GitCommitInfo {
                        sha,
                        short_sha,
                        message: c
                            .get("subject")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        author: c
                            .get("author")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        timestamp: c.get("timestamp").and_then(Value::as_i64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(commits)
}

/// Read a file from the working tree. Path is relative to `repo_path`.
#[tauri::command]
pub async fn git_read_file(repo_path: String, file_path: String) -> Result<String, StudioError> {
    let v = harness::repo_rpc("file.read", &repo_path, json!({ "filePath": file_path }))
        .await
        .map_err(StudioError::Other)?;
    if v.get("tooLarge").and_then(Value::as_bool) == Some(true) {
        let bytes = v.get("bytes").and_then(Value::as_u64).unwrap_or(0);
        return Err(StudioError::Other(format!(
            "'{file_path}' is too large to open inline ({bytes} bytes)"
        )));
    }
    v.get("content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| StudioError::Other(format!("Cannot read '{file_path}'")))
}

// ── Diff content for MergeView ────────────────────────────────────────────────

/// Both file versions for a side-by-side diff viewer (e.g. CodeMirror MergeView).
/// New files have an empty `original`; deleted files have an empty `modified`.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct GitDiffContent {
    pub original: String,
    pub modified: String,
}

/// Return the original and modified content of a file for a side-by-side diff.
///
/// - `staged = true`:  HEAD → index  (original = HEAD blob, modified = staged blob)
/// - `staged = false`: index → worktree (original = staged or HEAD blob, modified = working tree)
#[tauri::command]
pub async fn git_diff_content(
    repo_path: String,
    file_path: String,
    staged: bool,
) -> Result<GitDiffContent, StudioError> {
    if staged {
        let original = read_blob(&repo_path, &file_path, "git.readBlobAtHead")
            .await
            .unwrap_or_default();
        let modified = read_blob(&repo_path, &file_path, "git.readBlobAtIndex")
            .await
            .unwrap_or_default();
        return Ok(GitDiffContent { original, modified });
    }

    // Unstaged: original is the staged blob, falling back to HEAD; modified is
    // the working-tree content.
    let original = match read_blob(&repo_path, &file_path, "git.readBlobAtIndex").await {
        Some(c) => c,
        None => read_blob(&repo_path, &file_path, "git.readBlobAtHead")
            .await
            .unwrap_or_default(),
    };
    let modified = harness::repo_rpc(
        "git.diffContent",
        &repo_path,
        json!({ "filePath": file_path }),
    )
    .await
    .ok()
    .filter(|v| v.get("tooLarge").and_then(Value::as_bool) != Some(true))
    .and_then(|v| v.get("content").and_then(Value::as_str).map(str::to_string))
    .unwrap_or_default();
    Ok(GitDiffContent { original, modified })
}

/// Write content to a file in the working tree. Path is relative to `repo_path`.
#[tauri::command]
pub async fn git_write_file(
    repo_path: String,
    file_path: String,
    content: String,
) -> Result<(), StudioError> {
    let v = harness::repo_rpc(
        "file.write",
        &repo_path,
        json!({ "filePath": file_path, "content": content }),
    )
    .await
    .map_err(StudioError::Other)?;
    require_success(&v)
}

/// Commit the current index with the given message. Returns the commit SHA.
#[tauri::command]
pub async fn git_commit(repo_path: String, message: String) -> Result<String, StudioError> {
    let v = harness::repo_rpc("git.commit", &repo_path, json!({ "message": message }))
        .await
        .map_err(StudioError::Other)?;
    require_success(&v)?;
    Ok(v.get("sha")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, status: &str) -> Value {
        json!({ "path": path, "status": status })
    }

    #[test]
    fn buckets_porcelain_xy_codes() {
        let files = vec![
            entry("staged.txt", "M "), // staged modified
            entry("both.txt", "MM"),   // staged + unstaged modified
            entry("wt.txt", " M"),     // unstaged modified
            entry("new.txt", "A "),    // staged new
            entry("gone.txt", " D"),   // unstaged deleted
            entry("untracked.txt", "??"),
            entry("conflict.txt", "UU"),
        ];
        let (staged, unstaged, untracked) = bucket_porcelain(&files);

        let staged: Vec<_> = staged
            .iter()
            .map(|e| (e.path.as_str(), e.status.as_str()))
            .collect();
        assert!(staged.contains(&("staged.txt", "modified")));
        assert!(staged.contains(&("both.txt", "modified")));
        assert!(staged.contains(&("new.txt", "new")));

        let unstaged: Vec<_> = unstaged
            .iter()
            .map(|e| (e.path.as_str(), e.status.as_str()))
            .collect();
        assert!(unstaged.contains(&("both.txt", "modified")));
        assert!(unstaged.contains(&("wt.txt", "modified")));
        assert!(unstaged.contains(&("gone.txt", "deleted")));
        assert!(unstaged.contains(&("conflict.txt", "conflicted")));

        assert_eq!(untracked.len(), 1);
        assert_eq!(untracked[0].path, "untracked.txt");
        // A conflicted path is reported once, in the unstaged bucket.
        assert_eq!(
            staged.iter().filter(|(p, _)| *p == "conflict.txt").count(),
            0
        );
    }

    #[test]
    fn maps_status_chars() {
        assert_eq!(map_status_char(b'A'), "new");
        assert_eq!(map_status_char(b'D'), "deleted");
        assert_eq!(map_status_char(b'R'), "renamed");
        assert_eq!(map_status_char(b'M'), "modified");
        assert_eq!(map_status_char(b'T'), "modified");
    }

    #[test]
    fn require_success_flags_failed_results() {
        assert!(require_success(&json!({ "success": true })).is_ok());
        assert!(require_success(&json!({ "branch": "main" })).is_ok()); // no field → ok
        let err = require_success(&json!({ "success": false, "error": "boom" }));
        assert!(err.is_err());
    }
}
