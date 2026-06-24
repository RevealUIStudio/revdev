//! Integration tests: Studio's Rust JSON-RPC client (`studio_lib::harness`)
//! against a REAL harness daemon (`node packages/daemon/dist/cli.js`) over a
//! Unix domain socket.
//!
//! Run serially: `cargo test ... -- --test-threads=1`. The client resolves
//! its socket from the process-global `REVDEV_TEST_SOCKET` env var, so
//! concurrent tests pointing at different sockets would race each other.
//! The CI workflow (studio-rust-tests.yml) enforces this.
//!
//! Scope note: the daemon license-gates `tasks.*` / `mail.*` (pro+), and
//! these tests run the daemon unlicensed (free tier) so they exercise the
//! free-tier surface — ping, session lifecycle, harness.health. Transport
//! semantics (timeout, retry, framing, error mapping) are method-agnostic,
//! which is what this suite exists to prove.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use studio_lib::harness;

static DIR_COUNTER: AtomicU32 = AtomicU32::new(0);

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = apps/studio/src-tauri
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root resolves")
}

fn daemon_cli() -> PathBuf {
    let cli = repo_root().join("packages/daemon/dist/cli.js");
    assert!(
        cli.exists(),
        "daemon is not built — run `pnpm --filter @revdev/daemon build` first (looked at {})",
        cli.display()
    );
    cli
}

fn unique_dir(tag: &str) -> PathBuf {
    let n = DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("revdev-rs-{tag}-{}-{n}", std::process::id()))
}

/// A daemon child process bound to its own socket + data dir. Killed and
/// cleaned up on drop so a failing test cannot leak processes into CI.
struct DaemonGuard {
    child: Child,
    dir: PathBuf,
}

impl DaemonGuard {
    fn kill_and_wait(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        self.kill_and_wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Spawn a real daemon on a fresh socket + data dir, point the harness
/// client at it via REVDEV_TEST_SOCKET, and wait until it answers ping.
async fn spawn_daemon(tag: &str) -> DaemonGuard {
    let dir = unique_dir(tag);
    let socket = dir.join("harness.sock");
    spawn_daemon_at(&dir, &socket).await
}

async fn spawn_daemon_at(dir: &Path, socket: &Path) -> DaemonGuard {
    std::fs::create_dir_all(dir).expect("create daemon dir");
    let data_dir = dir.join(format!("db-{}", DIR_COUNTER.fetch_add(1, Ordering::Relaxed)));

    // The daemon enforces a root-owned trust anchor (review B-2) that an env
    // override cannot relax, so client-key enrollment is provisioned out-of-band
    // at the default /etc/revdev path via `provision_root_anchor()` (sudo) by
    // the one test that registers a client key. The daemon uses that default
    // path here — no env override.
    let child = Command::new("node")
        .arg(daemon_cli())
        .env("REVDEV_DAEMON_SOCKET", socket)
        .env("REVDEV_DAEMON_DATA", &data_dir)
        .env("REVDEV_DAEMON_PID", dir.join("harness.pid"))
        // Deterministic free-tier daemon regardless of the host shell's env.
        .env_remove("REVEALUI_LICENSE_KEY")
        .env_remove("REVDEV_LICENSE_PUBLIC_KEY")
        .env_remove("REVDEV_LICENSE_PUBLIC_KEY_FILE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn daemon child");

    std::env::set_var("REVDEV_TEST_SOCKET", socket);

    let guard = DaemonGuard {
        child,
        dir: dir.to_path_buf(),
    };
    wait_until_ready().await;
    guard
}

/// Ping until the daemon answers (PGlite WASM boot takes a few seconds).
/// The client's own retry ladder absorbs connection-refused while the
/// socket file exists but the listener isn't accepting yet.
async fn wait_until_ready() {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if harness::rpc_call("ping", serde_json::json!({})).await.is_ok() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "daemon never became ready within 60s"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[tokio::test]
async fn full_rpc_round_trip_against_real_daemon() {
    let _guard = spawn_daemon("roundtrip").await;

    // ping → pong
    let pong = harness::rpc_call("ping", serde_json::json!({}))
        .await
        .expect("ping succeeds");
    assert_eq!(pong.get("pong"), Some(&serde_json::Value::Bool(true)));

    // session.register via ensure_session → non-empty cached agent id
    let agent_id = harness::ensure_session().await.expect("session registers");
    assert!(!agent_id.is_empty(), "ensure_session returned an empty id");

    // session.list (license-exempt) shows our registration, with the
    // client-injected actorAgentId accepted by the daemon's Zod layer.
    let list = harness::rpc_call("session.list", serde_json::json!({}))
        .await
        .expect("session.list succeeds");
    assert!(
        session_ids(&list).iter().any(|id| id == &agent_id),
        "session.list does not show our registration {agent_id}: {list}"
    );

    // session.end → the session drops out of the active list.
    harness::rpc_call("session.end", serde_json::json!({ "sessionId": agent_id }))
        .await
        .expect("session.end succeeds");
    let after = harness::rpc_call("session.list", serde_json::json!({}))
        .await
        .expect("session.list succeeds after end");
    assert!(
        !session_ids(&after).iter().any(|id| id == &agent_id),
        "ended session {agent_id} still listed as active: {after}"
    );

    // The daemon runs unlicensed (free tier) here, and harness.health is
    // LICENSE-gated (the license-exempt set is only ping + session.* —
    // narrower than the identity-exempt set). Assert the gate end to end
    // through the Rust client: a clean RPC-level "License required", not
    // a transport error.
    let gated = harness::rpc_call("harness.health", serde_json::json!({}))
        .await
        .expect_err("harness.health must be license-gated on a free-tier daemon");
    assert!(
        gated.contains("License required"),
        "expected the license gate, got: {gated}"
    );
}

/// Extract the `id` column of every row in a `session.list` response.
fn session_ids(list: &serde_json::Value) -> Vec<String> {
    list.get("sessions")
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.get("id").and_then(|v| v.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_else(|| panic!("session.list returned no sessions array: {list}"))
}

#[tokio::test]
async fn unreachable_daemon_errors_after_retry_ladder() {
    let dir = unique_dir("unreachable");
    std::fs::create_dir_all(&dir).expect("create dir");
    std::env::set_var("REVDEV_TEST_SOCKET", dir.join("nobody-home.sock"));

    let started = Instant::now();
    let err = harness::rpc_call("ping", serde_json::json!({}))
        .await
        .expect_err("ping against a dead socket must fail");
    let elapsed = started.elapsed();

    assert!(
        err.starts_with("Harness daemon not running:"),
        "unexpected error: {err}"
    );
    // 3 attempts with 100ms + 500ms backoff between them — proves the
    // retry ladder actually ran rather than failing on first connect.
    assert!(
        elapsed >= Duration::from_millis(550),
        "expected retry backoff to elapse, got {elapsed:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn fresh_connection_per_call_survives_daemon_restart() {
    let dir = unique_dir("restart");
    let socket = dir.join("harness.sock");

    let mut first = spawn_daemon_at(&dir, &socket).await;
    assert!(
        harness::rpc_call("ping", serde_json::json!({})).await.is_ok(),
        "first daemon answers"
    );

    // Hard-kill the daemon: the stale socket file stays behind.
    first.kill_and_wait();
    let err = harness::rpc_call("ping", serde_json::json!({}))
        .await
        .expect_err("ping must fail while the daemon is down");
    assert!(
        err.starts_with("Harness daemon not running:") || err.starts_with("RPC timeout"),
        "unexpected down-state error: {err}"
    );

    // A replacement daemon on the SAME socket path (fresh data dir —
    // PGlite may hold a stale lock in the old one). Startup unlinks the
    // stale socket before binding; the client needs no reset because it
    // opens a fresh connection per call.
    let _second = spawn_daemon_at(&dir, &socket).await;
    let pong = harness::rpc_call("ping", serde_json::json!({}))
        .await
        .expect("ping succeeds against the replacement daemon");
    assert_eq!(pong.get("pong"), Some(&serde_json::Value::Bool(true)));

    // `first` was already killed; its Drop now only removes the shared dir
    // AFTER `_second`'s Drop killed the replacement (reverse drop order).
}

#[tokio::test]
async fn rpc_level_errors_are_returned_not_retried() {
    let _guard = spawn_daemon("rpcerr").await;

    let started = Instant::now();
    let err = harness::rpc_call("definitely.not.a.method", serde_json::json!({}))
        .await
        .expect_err("unknown method must fail");
    let elapsed = started.elapsed();

    assert!(
        !err.starts_with("Harness daemon not running:"),
        "daemon was reachable; got transport error instead of RPC error: {err}"
    );
    // RPC-level failures are permanent — no 10s-per-attempt timeout burn.
    assert!(
        elapsed < Duration::from_secs(8),
        "RPC error should not consume the retry ladder, took {elapsed:?}"
    );
}
