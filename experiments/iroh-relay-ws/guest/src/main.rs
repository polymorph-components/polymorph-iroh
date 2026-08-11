//! Spike guest: two upstream-iroh endpoints in one wasip2 component —
//! relay connectivity plus live migration onto a WebRTC data channel
//! through the synthetic-address overlay (issue #26).
//!
//! The guest runs stock iroh IP transports; nothing here knows about
//! WebRTC. The host bridge assigns each endpoint a synthetic IP address
//! and routes datagrams for it over a real unreliable/unordered data
//! channel. The guest feeds that address to iroh with
//! `Endpoint::add_external_addr` once the bridge reports the channel
//! ready; iroh advertises it to the peer through the NAT-traversal
//! candidate exchange on the live relay connection, the peer's
//! holepunch probes arrive over the channel (there is no NAT — the shim
//! terminates them), the path validates like any direct path, and the
//! selector migrates the connection off the relay. One connection, one
//! stream, echo RTT measured before and after.
//!
//! The custom-transport route this replaces is upstream-blocked (custom
//! addrs are excluded from the candidate exchange; see PR #25's
//! findings). Address lookup stays cleared so the synthetic address is
//! never published to discovery — the fiction stays inside the shim.

use std::net::{Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

use iroh::{
    Endpoint, EndpointAddr, RelayMode, RelayUrl, SecretKey, TransportAddr,
    endpoint::{Connection, presets},
};

const ALPN: &[u8] = b"/iroh-relay-ws-spike/echo/1";
const ECHOES: u32 = 50;
const PAYLOAD: usize = 512;
const MIGRATE_TIMEOUT: Duration = Duration::from_secs(15);

const OVERLAY_CONTROL_ADDR: (Ipv4Addr, u16) = (Ipv4Addr::LOCALHOST, 2);
const TAG_REGISTER: u8 = 0x00;
const TAG_ASSIGNED: u8 = 0x01;
const TAG_READY: u8 = 0x02;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build runtime");
    rt.block_on(run());
    println!("guest: exit");
}

/// The guest side of the overlay control protocol (see
/// host/webrtc-bridge.mjs): registers the endpoint's identity and iroh
/// UDP port, and receives the assigned synthetic address plus channel
/// readiness.
struct Overlay {
    sock: tokio::net::UdpSocket,
    external_addr: SocketAddr,
}

impl Overlay {
    async fn register(endpoint: &Endpoint) -> Overlay {
        let udp_port = endpoint
            .bound_sockets()
            .iter()
            .find(|a| a.is_ipv4())
            .expect("an ipv4 UDP socket")
            .port();
        let sock = tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind overlay control socket");
        let mut frame = [0u8; 1 + 32 + 2];
        frame[0] = TAG_REGISTER;
        frame[1..33].copy_from_slice(endpoint.id().as_bytes());
        frame[33..35].copy_from_slice(&udp_port.to_be_bytes());
        sock.send_to(&frame, OVERLAY_CONTROL_ADDR)
            .await
            .expect("send overlay register");
        let mut buf = [0u8; 64];
        loop {
            let (n, _) = sock.recv_from(&mut buf).await.expect("overlay recv");
            if n >= 7 && buf[0] == TAG_ASSIGNED {
                let ip = Ipv4Addr::new(buf[1], buf[2], buf[3], buf[4]);
                let port = u16::from_be_bytes([buf[5], buf[6]]);
                return Overlay {
                    sock,
                    external_addr: SocketAddr::from((ip, port)),
                };
            }
        }
    }

    /// Resolves once a data channel to a peer is open. Readiness gates
    /// `add_external_addr`: probes sent before that are only buffered.
    async fn ready(&self) {
        let mut buf = [0u8; 64];
        loop {
            let (n, _) = self.sock.recv_from(&mut buf).await.expect("overlay recv");
            if n >= 1 && buf[0] == TAG_READY {
                return;
            }
        }
    }
}

async fn bind_endpoint(relay_url: RelayUrl, alpns: Vec<Vec<u8>>) -> Endpoint {
    Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::generate())
        .relay_mode(RelayMode::custom([relay_url]))
        .clear_address_lookup()
        .alpns(alpns)
        .bind()
        .await
        .expect("bind endpoint")
}

fn selected_path(conn: &Connection) -> &'static str {
    let paths = conn.paths();
    let Some(p) = paths.iter().find(|p| p.is_selected()) else {
        return "none";
    };
    match p.remote_addr() {
        TransportAddr::Relay(_) => "relay",
        TransportAddr::Ip(_) => "ip",
        _ => "other",
    }
}

fn print_paths(conn: &Connection, label: &str) {
    for p in conn.paths().iter() {
        println!(
            "guest: path [{label}] {} selected={} rtt={:?}",
            p.remote_addr(),
            p.is_selected(),
            p.rtt()
        );
    }
}

async fn echo_phase(
    conn: &Connection,
    send: &mut iroh::endpoint::SendStream,
    recv: &mut iroh::endpoint::RecvStream,
    label: &str,
) {
    let payload = vec![0xA5u8; PAYLOAD];
    let mut back = vec![0u8; PAYLOAD];
    let mut rtts = Vec::with_capacity(ECHOES as usize);
    for _ in 0..ECHOES {
        let t = Instant::now();
        send.write_all(&payload).await.expect("client write");
        recv.read_exact(&mut back).await.expect("client read");
        rtts.push(t.elapsed());
    }
    rtts.sort();
    let p = |q: f64| rtts[((rtts.len() - 1) as f64 * q) as usize];
    println!(
        "guest: echo rtt [{label}] path={}: p50={}us p90={}us max={}us ({} rounds, {} byte payload)",
        selected_path(conn),
        p(0.5).as_micros(),
        p(0.9).as_micros(),
        rtts[rtts.len() - 1].as_micros(),
        ECHOES,
        PAYLOAD
    );
}

async fn run() {
    let relay_url: RelayUrl = "http://127.0.0.1:3340".parse().expect("relay url");
    println!("guest: start relay={relay_url}");

    let a = bind_endpoint(relay_url.clone(), vec![ALPN.to_vec()]).await;
    let b = bind_endpoint(relay_url.clone(), vec![]).await;
    println!("guest: a={} b={}", a.id(), b.id());

    // Registering both endpoints starts eager channel pairing in the
    // bridge, concurrent with everything below.
    let overlay_a = Overlay::register(&a).await;
    let overlay_b = Overlay::register(&b).await;
    println!(
        "guest: overlay addrs a={} b={}",
        overlay_a.external_addr, overlay_b.external_addr
    );

    a.online().await;
    b.online().await;
    println!("guest: both online (home relay up)");

    // A: accept one connection, echo one bi stream across both phases.
    let a2 = a.clone();
    let server = tokio::spawn(async move {
        let incoming = a2.accept().await.expect("accept incoming");
        let conn = incoming.await.expect("incoming handshake");
        println!("guest: a accepted from {}", conn.remote_id());
        let (mut send, mut recv) = conn.accept_bi().await.expect("accept_bi");
        let mut buf = vec![0u8; PAYLOAD];
        for _ in 0..(2 * ECHOES) {
            recv.read_exact(&mut buf).await.expect("server read");
            send.write_all(&buf).await.expect("server write");
        }
        send.finish().expect("finish");
        conn.closed().await;
    });

    // Phase 1: relay-only dial; iroh knows no other addresses yet.
    let addr = EndpointAddr::from_parts(a.id(), [TransportAddr::Relay(relay_url)]);
    let t_dial = Instant::now();
    let conn = b.connect(addr, ALPN).await.expect("connect");
    println!(
        "guest: b connected to a in {}ms (path: {})",
        t_dial.elapsed().as_millis(),
        selected_path(&conn)
    );
    let (mut send, mut recv) = conn.open_bi().await.expect("open_bi");
    echo_phase(&conn, &mut send, &mut recv, "phase 1").await;

    // The upgrade: once the channel is ready, hand each endpoint its
    // synthetic address. iroh advertises it on the live connection,
    // holepunches through the shim, and migrates — no reconnect.
    overlay_a.ready().await;
    overlay_b.ready().await;
    a.add_external_addr(overlay_a.external_addr).await;
    b.add_external_addr(overlay_b.external_addr).await;
    println!("guest: overlay addrs handed to iroh; waiting for migration");

    let t_migrate = Instant::now();
    loop {
        if selected_path(&conn) == "ip" {
            println!(
                "guest: connection migrated off the relay {}ms after addrs were added",
                t_migrate.elapsed().as_millis()
            );
            break;
        }
        if t_migrate.elapsed() > MIGRATE_TIMEOUT {
            println!("guest: WARNING no migration within {MIGRATE_TIMEOUT:?}");
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    print_paths(&conn, "post-migration");

    // Phase 2: same connection, same stream, new path.
    echo_phase(&conn, &mut send, &mut recv, "phase 2").await;

    send.finish().expect("client finish");
    conn.close(0u32.into(), b"done");
    server.await.expect("server task");

    a.close().await;
    b.close().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    println!("guest: done");
}
