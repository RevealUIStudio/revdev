//! `revdev-relay` — AF_UNIX ↔ stdio relay for the zero-9P transport (ADR P1).
//!
//! Runs INSIDE WSL, launched by Windows Studio as a `wsl.exe` child. It
//! connects to the RevDev daemon's Unix domain socket and pumps bytes
//! bidirectionally between that socket and its own stdin/stdout, so Studio can
//! speak the daemon's newline-delimited JSON-RPC over the child's pipes without
//! any Windows process touching ext4 or the 9P redirector.
//!
//! The daemon therefore only ever sees an ordinary local Unix-socket
//! connection — the wire protocol, framing, and handlers are byte-identical
//! across platforms. Windows Studio keeps one relay child and writes many
//! newline-framed requests on stdin. Native Unix still opens a fresh
//! `UnixStream` per call.
//!
//! Pure std, zero dependencies — a fully-owned, auditable byte pump.

use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::process::ExitCode;
use std::thread;

/// Copy `from` to `to`, flushing after every read. Piped stdout is fully
/// buffered; `io::copy` would hold a daemon line until the socket closed.
fn pump_and_flush(mut from: impl Read, mut to: impl Write) -> io::Result<()> {
    let mut buf = [0u8; 8192];
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            break;
        }
        to.write_all(&buf[..n])?;
        to.flush()?;
    }
    Ok(())
}

fn main() -> ExitCode {
    let socket_path = match std::env::args().nth(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: revdev-relay <unix-socket-path>");
            return ExitCode::from(2);
        }
    };

    let stream = match UnixStream::connect(&socket_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("revdev-relay: connect {socket_path}: {e}");
            return ExitCode::from(1);
        }
    };

    // One half-duplex pump per direction. stdin → socket runs on a worker
    // thread; socket → stdout runs on the main thread and ends when the daemon
    // closes its write side (EOF), at which point the relay exits.
    let mut to_socket = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("revdev-relay: clone socket: {e}");
            return ExitCode::from(1);
        }
    };
    let from_socket = stream;

    let pump_in = thread::spawn(move || {
        let stdin = io::stdin().lock();
        let _ = pump_and_flush(stdin, &mut to_socket);
        // Half-close so the daemon observes EOF and can finish responding even
        // if the client closed its stdin right after sending the request.
        let _ = to_socket.shutdown(Shutdown::Write);
    });

    let stdout = io::stdout().lock();
    let _ = pump_and_flush(from_socket, stdout);
    let _ = pump_in.join();

    ExitCode::SUCCESS
}
