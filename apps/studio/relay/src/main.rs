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
//! across platforms. Studio's per-call model spawns one relay per request
//! (mirroring its fresh-`UnixStream`-per-call on native Unix).
//!
//! Pure std, zero dependencies — a fully-owned, auditable byte pump.

use std::io::{self, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::process::ExitCode;
use std::thread;

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
    let mut from_socket = stream;

    let pump_in = thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let _ = io::copy(&mut stdin, &mut to_socket);
        // Half-close so the daemon observes EOF and can finish responding even
        // if the client closed its stdin right after sending the request.
        let _ = to_socket.shutdown(Shutdown::Write);
    });

    let mut stdout = io::stdout().lock();
    let _ = io::copy(&mut from_socket, &mut stdout);
    let _ = stdout.flush();
    let _ = pump_in.join();

    ExitCode::SUCCESS
}
