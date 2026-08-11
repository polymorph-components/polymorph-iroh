//! Spike guest: stock iroh-blobs on wasm32-wasip2 — two endpoints in one
//! component, a provider (A) and a fetcher (B).
//!
//! A adds pseudorandom blobs to a `MemStore` and serves them through the
//! stock `BlobsProtocol` router handler. B connects over the relay and
//! fetches blob 1 (phase 1: relay path, bao-verified streaming), then the
//! synthetic-address overlay migrates the live connection onto a WebRTC
//! data channel (issue #26; same bridge as the iroh-relay-ws spike) and B
//! fetches blob 2 over the migrated connection (phase 2: direct path).
//! Both fetch durations and the in-guest hashing time are printed — the
//! ecosystem-compatibility numbers PR #25 is after.
//!
//! Environment: `BLOB_MB` (default 4) sizes each blob; `RELAY` overrides
//! the relay URL (the run harness passes the local dev relay).

use std::net::{Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

use iroh::{
    Endpoint, EndpointAddr, RelayMode, RelayUrl, SecretKey, TransportAddr,
    endpoint::{Connection, presets},
    protocol::Router,
};
use iroh_blobs::{BlobsProtocol, store::mem::MemStore};

const OVERLAY_ADDR: (Ipv4Addr, u16) = (Ipv4Addr::LOCALHOST, 2);
const TAG_REGISTER: u8 = 0x00;
const TAG_ASSIGNED: u8 = 0x01;
const TAG_READY: u8 = 0x02;
const MIGRATE_TIMEOUT: Duration = Duration::from_secs(15);

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

/// The overlay control client (see host/webrtc-bridge.mjs in the
/// iroh-relay-ws spike; identical protocol).
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
        sock.send_to(&frame, OVERLAY_ADDR)
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
        TransportAddr::Ip(_) => "direct",
        _ => "other",
    }
}

/// Deterministic pseudorandom fill (xorshift64*), seeded per blob so the
/// two blobs differ.
fn make_blob(mb: usize, seed: u64) -> Vec<u8> {
    let mut out = vec![0u8; mb * 1024 * 1024];
    let mut s = seed | 1;
    for chunk in out.chunks_mut(8) {
        s ^= s >> 12;
        s ^= s << 25;
        s ^= s >> 27;
        let v = s.wrapping_mul(0x2545_f491_4f6c_dd1d).to_le_bytes();
        chunk.copy_from_slice(&v[..chunk.len()]);
    }
    out
}

fn mbps(bytes: usize, elapsed: Duration) -> f64 {
    (bytes as f64 / (1024.0 * 1024.0)) / elapsed.as_secs_f64()
}

async fn run() {
    let relay_url: RelayUrl = std::env::var("RELAY")
        .unwrap_or_else(|_| "http://127.0.0.1:3340".into())
        .parse()
        .expect("relay url");
    let blob_mb: usize = std::env::var("BLOB_MB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4);
    println!("guest: start relay={relay_url} blob={blob_mb}MiB");

    let a = bind_endpoint(relay_url.clone(), vec![iroh_blobs::ALPN.to_vec()]).await;
    let b = bind_endpoint(relay_url.clone(), vec![]).await;
    println!("guest: a={} b={}", a.id(), b.id());

    let overlay_a = Overlay::register(&a).await;
    let overlay_b = Overlay::register(&b).await;

    a.online().await;
    b.online().await;
    println!("guest: both online (home relay up)");

    // Provider: stock MemStore + BlobsProtocol behind the stock Router.
    let store_a = MemStore::new();
    let t_add = Instant::now();
    let blob1 = store_a
        .add_bytes(make_blob(blob_mb, 1))
        .await
        .expect("add blob 1");
    let blob2 = store_a
        .add_bytes(make_blob(blob_mb, 2))
        .await
        .expect("add blob 2");
    println!(
        "guest: a added 2x{blob_mb}MiB in {}ms ({:.1} MiB/s hashing)",
        t_add.elapsed().as_millis(),
        mbps(2 * blob_mb * 1024 * 1024, t_add.elapsed())
    );
    let router = Router::builder(a.clone())
        .accept(iroh_blobs::ALPN, BlobsProtocol::new(&store_a, None))
        .spawn();

    // Fetcher: one connection, relay first.
    let store_b = MemStore::new();
    let addr = EndpointAddr::from_parts(a.id(), [TransportAddr::Relay(relay_url)]);
    let t_dial = Instant::now();
    let conn = b.connect(addr, iroh_blobs::ALPN).await.expect("connect");
    println!(
        "guest: b connected to a in {}ms (path: {})",
        t_dial.elapsed().as_millis(),
        selected_path(&conn)
    );

    // Phase 1: verified fetch over the relay.
    let t_fetch = Instant::now();
    store_b
        .remote()
        .fetch(conn.clone(), blob1.hash)
        .await
        .expect("fetch blob 1");
    let elapsed = t_fetch.elapsed();
    println!(
        "guest: fetch [phase 1] path={}: {blob_mb}MiB in {}ms = {:.2} MiB/s",
        selected_path(&conn),
        elapsed.as_millis(),
        mbps(blob_mb * 1024 * 1024, elapsed)
    );

    // The upgrade: hand both endpoints their synthetic addresses once the
    // bridge reports the (eagerly paired) channel open; iroh advertises
    // in-band, punches through the shim, and migrates the live connection.
    overlay_a.ready().await;
    overlay_b.ready().await;
    a.add_external_addr(overlay_a.external_addr).await;
    b.add_external_addr(overlay_b.external_addr).await;

    let t_migrate = Instant::now();
    loop {
        if selected_path(&conn) == "direct" {
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

    // Phase 2: verified fetch over the migrated connection.
    let t_fetch = Instant::now();
    store_b
        .remote()
        .fetch(conn.clone(), blob2.hash)
        .await
        .expect("fetch blob 2");
    let elapsed = t_fetch.elapsed();
    println!(
        "guest: fetch [phase 2] path={}: {blob_mb}MiB in {}ms = {:.2} MiB/s",
        selected_path(&conn),
        elapsed.as_millis(),
        mbps(blob_mb * 1024 * 1024, elapsed)
    );

    conn.close(0u32.into(), b"done");
    router.shutdown().await.ok();
    a.close().await;
    b.close().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    println!("guest: done");
}
