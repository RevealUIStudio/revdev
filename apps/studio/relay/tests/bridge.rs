//! Integration test for the built `revdev-relay` binary: it must faithfully
//! bridge stdin/stdout to a Unix socket in both directions.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixListener;
use std::process::{Command, Stdio};
use std::thread;

#[test]
fn relay_bridges_stdin_to_socket_and_socket_to_stdout() {
    let dir = std::env::temp_dir().join(format!("revdev-relay-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let sock = dir.join("t.sock");
    let _ = std::fs::remove_file(&sock);

    let listener = UnixListener::bind(&sock).unwrap();

    // Mock daemon: read one newline-framed request, write a framed response,
    // then close (so the relay's socket→stdout copy sees EOF and exits).
    let server = thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(conn.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let mut writer = conn;
        writer.write_all(format!("RESP:{line}").as_bytes()).unwrap();
        writer.flush().unwrap();
        // drop(writer) closes the connection.
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_revdev-relay"))
        .arg(&sock)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    {
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"hello\n").unwrap();
        // drop(stdin) sends EOF to the relay's stdin→socket pump.
    }

    let mut out = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut out)
        .unwrap();
    let status = child.wait().unwrap();
    server.join().unwrap();

    assert_eq!(out, "RESP:hello\n");
    assert!(status.success());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Studio keeps the WSL relay's stdin open (one child, many RPCs). The mock
/// daemon must also keep the socket open. stdout is a pipe, so libc will
/// block-buffer unless the relay flushes after each write.
#[test]
fn relay_flushes_stdout_while_both_sides_stay_open() {
    use std::sync::mpsc;
    use std::time::Duration;

    let dir = std::env::temp_dir().join(format!("revdev-relay-flush-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let sock = dir.join("t.sock");
    let _ = std::fs::remove_file(&sock);

    let listener = UnixListener::bind(&sock).unwrap();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let server = thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(conn.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let mut writer = conn;
        writer
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"pong\":true}}\n")
            .unwrap();
        writer.flush().unwrap();
        let _ = release_rx.recv();
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_revdev-relay"))
        .arg(&sock)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n")
        .unwrap();

    let stdout = child.stdout.take().unwrap();
    let (line_tx, line_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = line_tx.send(line);
    });

    let line = line_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("relay did not flush the daemon line while the socket stayed open");
    assert!(
        line.contains("pong"),
        "expected a ping result, got {line:?}"
    );

    drop(child.stdin.take());
    let _ = release_tx.send(());
    let _ = child.wait();
    let _ = server.join();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn relay_exits_nonzero_when_socket_missing() {
    let missing = std::env::temp_dir().join("revdev-relay-does-not-exist.sock");
    let _ = std::fs::remove_file(&missing);
    let status = Command::new(env!("CARGO_BIN_EXE_revdev-relay"))
        .arg(&missing)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(!status.success());
}
