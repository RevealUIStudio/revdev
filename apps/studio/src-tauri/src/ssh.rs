use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD as BASE64, STANDARD_NO_PAD};
use russh::keys::{PublicKey, PublicKeyBase64};
use russh::{ChannelId, ChannelMsg, ChannelWriteHalf, client};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tokio::sync::Mutex;
use ts_rs::TS;

// ── Types ────────────────────────────────────────────────────────────────────

/// Authentication method for SSH connections.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(tag = "method")]
#[ts(export, export_to = "bindings/")]
pub enum SshAuth {
    #[serde(rename = "password")]
    Password { password: String },
    #[serde(rename = "key")]
    Key {
        key_path: String,
        passphrase: Option<String>,
    },
}

/// Event payload sent from backend to frontend with terminal output.
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct SshOutputEvent {
    pub session_id: String,
    pub data: String, // base64-encoded bytes
}

/// Event payload for session disconnect notifications.
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct SshDisconnectEvent {
    pub session_id: String,
    pub reason: String,
}

/// Event payload for host key verification notifications.
#[derive(Clone, Serialize, TS)]
#[ts(export, export_to = "bindings/")]
pub struct SshHostKeyEvent {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub key_type: String,
    /// "new" = TOFU (added to known_hosts), "match" = verified, "mismatch" = REJECTED
    pub status: String,
}

/// Holds a single SSH session's handle and channel.
///
/// Only the channel's write half is stored. The read half is owned exclusively
/// by that session's output task, so a `wait()` parked on an idle prompt can
/// never block a concurrent `data()` or `window_change()`.
pub struct SshSession {
    pub handle: client::Handle<SshClientHandler>,
    pub channel: Arc<ChannelWriteHalf<client::Msg>>,
}

/// Managed Tauri state for SSH sessions.
pub struct SshState {
    pub sessions: Arc<Mutex<HashMap<String, SshSession>>>,
}

impl Default for SshState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ── Known Hosts ──────────────────────────────────────────────────────────────

enum KnownHostStatus {
    /// Host key matches a known_hosts entry.
    Match,
    /// Host is in known_hosts but with a different key (possible MITM).
    Mismatch,
    /// Host not found in known_hosts.
    Unknown,
}

/// Compute SSH fingerprint: SHA256:<base64-no-pad hash of wire-format key>.
fn compute_fingerprint(key: &PublicKey) -> String {
    let bytes = key.public_key_bytes();
    let hash = Sha256::digest(&bytes);
    format!("SHA256:{}", STANDARD_NO_PAD.encode(hash))
}

/// Build the hostname pattern used in known_hosts (bracketed with port if non-standard).
fn host_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// Check if a host key is in ~/.ssh/known_hosts.
fn check_known_hosts_file(host: &str, port: u16, key: &PublicKey) -> KnownHostStatus {
    let known_hosts_path = match dirs::home_dir() {
        Some(home) => home.join(".ssh").join("known_hosts"),
        None => return KnownHostStatus::Unknown,
    };

    let contents = match std::fs::read_to_string(&known_hosts_path) {
        Ok(c) => c,
        Err(_) => return KnownHostStatus::Unknown,
    };

    let pattern = host_pattern(host, port);
    let algorithm = key.algorithm();
    let key_algo = algorithm.as_str();
    let key_b64 = key.public_key_base64();

    for line in contents.lines() {
        let line = line.trim();
        // Skip comments, empty lines, and hashed entries (|1|…)
        if line.is_empty() || line.starts_with('#') || line.starts_with('|') {
            continue;
        }

        let parts: Vec<&str> = line.splitn(3, ' ').collect();
        if parts.len() < 3 {
            continue;
        }

        let hosts_field = parts[0];
        let algo = parts[1];
        // Strip any trailing comment after the key
        let stored_key = parts[2].split_whitespace().next().unwrap_or("");

        let host_matches = hosts_field.split(',').any(|h| h.trim() == pattern);
        if !host_matches {
            continue;
        }

        if algo == key_algo && stored_key == key_b64 {
            return KnownHostStatus::Match;
        }
        return KnownHostStatus::Mismatch;
    }

    KnownHostStatus::Unknown
}

/// Append a host key entry to ~/.ssh/known_hosts (TOFU).
fn learn_known_host(host: &str, port: u16, key: &PublicKey) -> Result<(), String> {
    let known_hosts_path = dirs::home_dir()
        .ok_or("Cannot determine home directory")?
        .join(".ssh")
        .join("known_hosts");

    if let Some(parent) = known_hosts_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create ~/.ssh: {e}"))?;
    }

    let pattern = host_pattern(host, port);
    let line = format!("{} {} {}\n", pattern, key.algorithm().as_str(), key.public_key_base64());

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&known_hosts_path)
        .map_err(|e| format!("Failed to open known_hosts: {e}"))?;

    file.write_all(line.as_bytes())
        .map_err(|e| format!("Failed to write known_hosts: {e}"))?;

    Ok(())
}

// ── Client Handler ───────────────────────────────────────────────────────────

/// russh client handler — receives data from the SSH server and emits it to the frontend.
pub struct SshClientHandler {
    pub app_handle: tauri::AppHandle,
    pub session_id: String,
    pub host: String,
    pub port: u16,
}

impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = compute_fingerprint(server_public_key);
        let key_type = server_public_key.algorithm().as_str().to_string();

        match check_known_hosts_file(&self.host, self.port, server_public_key) {
            KnownHostStatus::Match => {
                let _ = self.app_handle.emit(
                    "ssh_host_key",
                    SshHostKeyEvent {
                        host: self.host.clone(),
                        port: self.port,
                        fingerprint,
                        key_type,
                        status: "match".to_string(),
                    },
                );
                Ok(true)
            }
            KnownHostStatus::Unknown => {
                // TOFU: Trust On First Use — accept and save.
                let _ = learn_known_host(&self.host, self.port, server_public_key);
                let _ = self.app_handle.emit(
                    "ssh_host_key",
                    SshHostKeyEvent {
                        host: self.host.clone(),
                        port: self.port,
                        fingerprint,
                        key_type,
                        status: "new".to_string(),
                    },
                );
                Ok(true)
            }
            KnownHostStatus::Mismatch => {
                let _ = self.app_handle.emit(
                    "ssh_host_key",
                    SshHostKeyEvent {
                        host: self.host.clone(),
                        port: self.port,
                        fingerprint,
                        key_type,
                        status: "mismatch".to_string(),
                    },
                );
                Ok(false)
            }
        }
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let encoded = BASE64.encode(data);
        let _ = self.app_handle.emit(
            "ssh_output",
            SshOutputEvent {
                session_id: self.session_id.clone(),
                data: encoded,
            },
        );
        Ok(())
    }
}

// ── Output pump ──────────────────────────────────────────────────────────────

/// A decoded message from a session's output stream.
pub enum PumpEvent {
    /// Base64-encoded bytes from the remote shell (stdout or stderr).
    Output(String),
    /// The remote side closed the channel.
    Disconnected(String),
}

/// Drive a channel's read half to completion, handing each decoded message to
/// `on_event`.
///
/// Takes the read half by value: nothing else can hold it, so a `wait()` parked
/// on an idle prompt can never block a concurrent `data()` / `window_change()`
/// on the write half. Keeping the two halves unshared is what makes the SSH
/// terminal responsive while the remote shell is silent, so do not reintroduce
/// a lock around either one.
pub async fn pump_output<F: Fn(PumpEvent)>(mut read_half: ChannelReadHalf, on_event: F) {
    loop {
        match read_half.wait().await {
            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                on_event(PumpEvent::Output(BASE64.encode(&*data)));
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                on_event(PumpEvent::Disconnected(
                    "Connection closed by server".to_string(),
                ));
                break;
            }
            _ => {}
        }
    }
}

// ── Connect ──────────────────────────────────────────────────────────────────

/// Connect to an SSH server, open a PTY and shell. Returns session ID.
pub async fn connect(
    host: String,
    port: u16,
    username: String,
    auth: SshAuth,
    app_handle: tauri::AppHandle,
    ssh_state: Arc<Mutex<HashMap<String, SshSession>>>,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();

    let config = Arc::new(client::Config::default());

    let handler = SshClientHandler {
        app_handle: app_handle.clone(),
        session_id: session_id.clone(),
        host: host.clone(),
        port,
    };

    let mut handle = client::connect(config, (host.as_str(), port), handler)
        .await
        .map_err(|e| format!("SSH connection failed: {e}"))?;

    match &auth {
        SshAuth::Password { password } => {
            let auth_result = handle
                .authenticate_password(&username, password)
                .await
                .map_err(|e| format!("SSH auth error: {e}"))?;
            if !auth_result.success() {
                return Err("Authentication failed: invalid credentials".to_string());
            }
        }
        SshAuth::Key {
            key_path,
            passphrase,
        } => {
            let path = Path::new(key_path);
            if !path.exists() {
                return Err(format!("Key file not found: {key_path}"));
            }
            let key_pair = russh::keys::load_secret_key(path, passphrase.as_deref())
                .map_err(|e| format!("Failed to load key: {e}"))?;
            let key_with_alg = russh::keys::PrivateKeyWithHashAlg::new(
                Arc::new(key_pair),
                None,
            );
            let auth_result = handle
                .authenticate_publickey(&username, key_with_alg)
                .await
                .map_err(|e| format!("SSH key auth error: {e}"))?;
            if !auth_result.success() {
                return Err("Authentication failed: key rejected by server".to_string());
            }
        }
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed to open channel: {e}"))?;

    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|e| format!("PTY request failed: {e}"))?;

    channel
        .request_shell(false)
        .await
        .map_err(|e| format!("Shell request failed: {e}"))?;

    let (read_half, write_half) = channel.split();
    let channel = Arc::new(write_half);

    // Spawn a task to poll channel output and emit events.
    let sid = session_id.clone();
    let ah = app_handle.clone();
    let state_clone = ssh_state.clone();
    tokio::spawn(async move {
        pump_output(read_half, |event| match event {
            PumpEvent::Output(data) => {
                let _ = ah.emit(
                    "ssh_output",
                    SshOutputEvent {
                        session_id: sid.clone(),
                        data,
                    },
                );
            }
            PumpEvent::Disconnected(reason) => {
                let _ = ah.emit(
                    "ssh_disconnect",
                    SshDisconnectEvent {
                        session_id: sid.clone(),
                        reason,
                    },
                );
            }
        })
        .await;

        // Clean up session from state
        let mut sessions = state_clone.lock().await;
        sessions.remove(&sid);
    });

    // Store session
    let mut sessions = ssh_state.lock().await;
    sessions.insert(
        session_id.clone(),
        SshSession {
            handle,
            channel,
        },
    );

    Ok(session_id)
}
