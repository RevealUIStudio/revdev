//! Regression test: a session parked at an idle prompt must not block writes.
//!
//! The SSH output task used to hold the channel mutex across `wait()`. A remote
//! shell sitting silently at a prompt leaves `wait()` pending indefinitely, so
//! the lock was never released and `ssh_send` / `ssh_resize` could not acquire
//! it: the terminal silently ate every keystroke until the server spoke first.
//!
//! `ssh::pump_output` now takes the channel's read half by value, and the write
//! half is shared separately, so no lock exists to contend on. This test pins
//! that invariant against an in-process russh server that stays deliberately
//! silent until it is written to.

#![cfg(unix)]

use std::sync::Arc;
use std::time::Duration;

use russh::keys::PrivateKey;
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::server::{Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId, client};
use tokio::sync::mpsc;

use studio_lib::ssh::{PumpEvent, pump_output};

// ── A silent echo server ─────────────────────────────────────────────────────
// Accepts any user, opens a session, and sends NOTHING until it receives data.
// The silence is the point: it reproduces an idle shell prompt.

#[derive(Clone)]
struct SilentEchoServer;

impl russh::server::Server for SilentEchoServer {
    type Handler = SilentEchoHandler;
    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> SilentEchoHandler {
        SilentEchoHandler
    }
}

struct SilentEchoHandler;

impl russh::server::Handler for SilentEchoHandler {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, data.to_vec())?;
        Ok(())
    }
}

// ── A client that trusts the throwaway host key ──────────────────────────────

struct AcceptAnyKey;

impl client::Handler for AcceptAnyKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

async fn start_server() -> u16 {
    // A fixed seed keeps the throwaway host key deterministic and avoids
    // depending on which rand_core version russh's key crate was built against.
    let key = PrivateKey::from(Ed25519Keypair::from_seed(&[7u8; 32]));
    let config = Arc::new(russh::server::Config {
        keys: vec![key],
        ..Default::default()
    });

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind ephemeral port");
    let port = listener.local_addr().expect("local addr").port();

    tokio::spawn(async move {
        let mut server = SilentEchoServer;
        let _ = server.run_on_socket(config, &listener).await;
    });

    port
}

/// With the reader parked in `wait()` against a silent server, a write must
/// still complete promptly, and its echo must come back through the pump.
#[tokio::test]
async fn idle_prompt_does_not_block_writes() {
    let port = start_server().await;

    let handle = client::connect(
        Arc::new(client::Config::default()),
        ("127.0.0.1", port),
        AcceptAnyKey,
    )
    .await
    .expect("connect");

    let mut handle = handle;
    assert!(
        handle.authenticate_none("tester").await.expect("auth").success(),
        "server should accept auth_none"
    );

    let channel = handle.channel_open_session().await.expect("open session");
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .expect("pty");
    channel.request_shell(false).await.expect("shell");

    let (read_half, write_half) = channel.split();
    let write_half = Arc::new(write_half);

    let (tx, mut rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        pump_output(read_half, move |event| {
            let _ = tx.send(event);
        })
        .await;
    });

    // Let the pump reach `wait()` and park there. The server is silent, so this
    // is exactly the idle-prompt state that used to wedge the old lock.
    tokio::time::sleep(Duration::from_millis(300)).await;

    // The write must not wait on the reader.
    let sent = tokio::time::timeout(Duration::from_secs(3), write_half.data(&b"ping\n"[..])).await;
    assert!(
        sent.is_ok(),
        "write blocked while the reader was parked at an idle prompt"
    );
    sent.unwrap().expect("data sent");

    // And the echo must arrive back through the pump.
    let echoed = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = rx.recv().await {
            if let PumpEvent::Output(b64) = event {
                return Some(b64);
            }
        }
        None
    })
    .await
    .expect("timed out waiting for echo")
    .expect("pump closed before echoing");

    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(echoed)
        .expect("pump emits base64");
    assert_eq!(decoded, b"ping\n");
}

/// A resize also must not block against a parked reader.
#[tokio::test]
async fn idle_prompt_does_not_block_resize() {
    let port = start_server().await;

    let mut handle = client::connect(
        Arc::new(client::Config::default()),
        ("127.0.0.1", port),
        AcceptAnyKey,
    )
    .await
    .expect("connect");

    assert!(
        handle.authenticate_none("tester").await.expect("auth").success(),
        "server should accept auth_none"
    );

    let channel = handle.channel_open_session().await.expect("open session");
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .expect("pty");
    channel.request_shell(false).await.expect("shell");

    let (read_half, write_half) = channel.split();
    let write_half = Arc::new(write_half);

    tokio::spawn(async move {
        pump_output(read_half, |_| {}).await;
    });

    tokio::time::sleep(Duration::from_millis(300)).await;

    let resized =
        tokio::time::timeout(Duration::from_secs(3), write_half.window_change(120, 40, 0, 0)).await;
    assert!(
        resized.is_ok(),
        "resize blocked while the reader was parked at an idle prompt"
    );
    resized.unwrap().expect("window_change sent");
}
