//! Integration tests: `studio_lib::daemon_ctl` lifecycle commands
//! (start / status / stop) against a REAL daemon, resolved through a shim
//! binary exactly the way a customer install resolves `revdev-daemon`.
//!
//! Run serially: `cargo test ... -- --test-threads=1` — daemon_ctl reads
//! REVDEV_DAEMON_BIN / REVDEV_DAEMON_PID and the harness client reads
//! REVDEV_TEST_SOCKET, all process-global env.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use studio_lib::daemon_ctl;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root resolves")
}

/// Everything daemon_ctl needs, isolated under one temp dir: a shim that
/// execs the real node daemon (mirroring the ~/.local/bin/revdev-daemon
/// install shape), plus pid/socket/data paths wired through env.
struct CtlEnv {
    dir: PathBuf,
}

impl CtlEnv {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("revdev-ctl-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create ctl dir");

        let cli = repo_root().join("packages/daemon/dist/cli.js");
        assert!(
            cli.exists(),
            "daemon is not built — run `pnpm --filter @revdev/daemon build` first (looked at {})",
            cli.display()
        );

        let socket = dir.join("harness.sock");
        let shim = dir.join("revdev-daemon");
        // The daemon child inherits this test process's env; the shim
        // unsets license vars so the spawned daemon is deterministic
        // free-tier, and execs node so the spawned PID *is* the daemon.
        let script = format!(
            "#!/bin/sh\nunset REVEALUI_LICENSE_KEY REVDEV_LICENSE_PUBLIC_KEY REVDEV_LICENSE_PUBLIC_KEY_FILE\nexec node \"{}\"\n",
            cli.display()
        );
        std::fs::write(&shim, script).expect("write shim");
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755))
            .expect("chmod shim");

        std::env::set_var("REVDEV_DAEMON_BIN", &shim);
        std::env::set_var("REVDEV_DAEMON_PID", dir.join("harness.pid"));
        std::env::set_var("REVDEV_DAEMON_SOCKET", &socket);
        std::env::set_var("REVDEV_DAEMON_DATA", dir.join("db"));
        std::env::set_var("REVDEV_TEST_SOCKET", &socket);

        CtlEnv { dir }
    }
}

impl Drop for CtlEnv {
    fn drop(&mut self) {
        // Best-effort: if a test failed mid-lifecycle, SIGTERM the daemon
        // recorded in the pid file so CI never leaks a node process.
        if let Ok(s) = std::fs::read_to_string(self.dir.join("harness.pid")) {
            if let Ok(pid) = s.trim().parse::<i32>() {
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
            }
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn daemon_lifecycle_start_status_stop() {
    let _env = CtlEnv::new("lifecycle");

    // Down: no pid file, nothing reachable.
    let before = daemon_ctl::daemon_status().await.expect("status (down)");
    assert!(!before.running, "no daemon should be running yet");

    // Start: daemon_start itself polls until the socket answers ping.
    let pid = daemon_ctl::daemon_start().await.expect("daemon_start succeeds");
    assert!(pid > 0);

    // Up: pid file + process + reachable socket. Poll briefly: start
    // returns on ping, and status.running is the pid file.
    let deadline = Instant::now() + Duration::from_secs(2);
    let during = loop {
        let status = daemon_ctl::daemon_status().await.expect("status (up)");
        if status.running {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "daemon should be running"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(during.pid, Some(pid), "pid file matches the spawned pid");
    assert!(during.reachable, "daemon should answer ping");

    // Double-start is refused while running.
    let already = daemon_ctl::daemon_start().await;
    assert!(
        already.is_err(),
        "second daemon_start must refuse while running: {already:?}"
    );

    // Stop: SIGTERM via pid file, graceful exit.
    daemon_ctl::daemon_stop().await.expect("daemon_stop succeeds");

    // The daemon's SIGTERM handler removes its pid file on the way out;
    // give it a moment, then confirm the process is gone.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let after = daemon_ctl::daemon_status().await.expect("status (down again)");
        if !after.running {
            assert!(!after.reachable, "stopped daemon must not answer ping");
            break;
        }
        assert!(Instant::now() < deadline, "daemon did not stop within 10s");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test]
async fn daemon_start_fails_cleanly_when_binary_is_broken() {
    let _env = CtlEnv::new("badbin");
    std::env::set_var("REVDEV_DAEMON_BIN", "/nonexistent/revdev-daemon");

    let result = daemon_ctl::daemon_start().await;
    let err = result.expect_err("starting a nonexistent binary must fail");
    assert!(
        err.contains("Failed to start daemon"),
        "unexpected error: {err}"
    );
}
