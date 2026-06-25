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
