//! Ping-demo guest: one iroh endpoint per page.
//!
//! The page (demo.mjs) owns all demo semantics; the guest is the
//! networking core. It binds an endpoint, connects host and joiner over
//! the relay, then ferries opaque frames between the page and the peer
//! over one bi stream. The webrtc upgrade is the synthetic-address
//! overlay from the iroh-relay-ws spike (issue #26): the page's bridge
//! assigns this endpoint a synthetic address and reports readiness once
//! the data channel opens; the guest hands the address to iroh, which
//! advertises it in-band and migrates the live connection.
//!
//! Environment (via the shim's GUEST_ENV):
//! - `ROLE`: "host" or "join"
//! - `SECRET`: hex ed25519 secret key — the page persists it per tab so
//!   an endpoint keeps its identity across refreshes (rejoin)
//! - `PEER`, `PEER_RELAY`: the host's endpoint id and home relay (join)
//! - `RELAY`: optional relay override for both roles (local testing;
//!   default is the n0 public relay map)
//!
//! Page protocol (synthetic port 3, one datagram each):
//! - empty: close the current session (best-effort "bye" on unload)
//! - first byte 0x01: an upload chunk (page -> guest, after a "send")
//! - first byte 0x02: a download chunk (guest -> page, during a fetch)
//! - JSON otherwise. The guest intercepts the page commands "send"
//!   (announce an upload; chunks follow) and "fetch" (retrieve a blob
//!   from the session peer); its own status events are "ready",
//!   "connected", "path", "closed", "error", "added", "file-start",
//!   "progress", "file-done", "file-error". Every other frame from the
//!   page is forwarded verbatim to the peer, and peer frames are
//!   delivered verbatim to the page. Stream framing: u16 BE length +
//!   bytes.
//!
//! Files ride stock iroh-blobs: uploads land in an in-memory store
//! (`MemStore`) and are served to the peer through the stock
//! `BlobsProtocol` on its own ALPN and connection (which shares the
//! session's migrated path — iroh opens the selected path on every
//! connection to the remote); fetches are bao-verified.
//!
//! Sessions loop: the host returns to accepting when a session ends
//! (refusing extra participants while one is active), and the joiner
//! redials every couple of seconds — either side can leave and rejoin.
//! Peer loss without a clean close is bounded by a shortened QUIC idle
//! timeout (keepalives are on by default, so live sessions never idle
//! out).
//!
//! Overlay control protocol (synthetic port 2): see the page bridge
//! (overlay.mjs); identical to the iroh-relay-ws spike.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey, TransportAddr,
    endpoint::{Connection, QuicTransportConfig, presets},
    protocol::ProtocolHandler,
};
use iroh_blobs::{BlobsProtocol, store::mem::MemStore};

const ALPN: &[u8] = b"/polymorph/ping-demo/1";
const PAGE_ADDR: (Ipv4Addr, u16) = (Ipv4Addr::LOCALHOST, 3);
const OVERLAY_ADDR: (Ipv4Addr, u16) = (Ipv4Addr::LOCALHOST, 2);
const TAG_REGISTER: u8 = 0x00;
const TAG_ASSIGNED: u8 = 0x01;
const TAG_READY: u8 = 0x02;
const TAG_UP_CHUNK: u8 = 0x01;
const TAG_DOWN_CHUNK: u8 = 0x02;
const MAX_FRAME: usize = 16 * 1024;
const DOWN_CHUNK: usize = MAX_FRAME - 1;
/// Peer-loss detection bound for abrupt departures (closed tabs rarely
/// manage to flush a CONNECTION_CLOSE).
const IDLE_TIMEOUT: Duration = Duration::from_secs(8);
const REDIAL_DELAY: Duration = Duration::from_secs(2);

/// Page commands the guest intercepts; any JSON that does not parse as
/// one is a peer frame and is forwarded verbatim.
#[derive(serde::Deserialize)]
#[serde(tag = "t")]
enum PageCommand {
    #[serde(rename = "send")]
    Send { id: u32, name: String, size: u64 },
    #[serde(rename = "fetch")]
    Fetch { hash: String, size: u64 },
}

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
}

/// Page channel: JSON datagrams to/from demo.mjs on synthetic port 3.
#[derive(Clone)]
struct Page(Arc<tokio::net::UdpSocket>);

impl Page {
    async fn bind() -> Page {
        let sock = tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind page socket");
        Page(Arc::new(sock))
    }

    async fn send_raw(&self, bytes: &[u8]) {
        self.0.send_to(bytes, PAGE_ADDR).await.expect("page send");
    }

    /// Sends a guest status event. `fields` must already be valid JSON
    /// fragments ("key":value); only guest-controlled values pass through
    /// here (hex ids, relay URLs, numbers).
    async fn event(&self, t: &str, fields: &[String]) {
        let mut msg = format!("{{\"t\":\"{t}\"");
        for f in fields {
            msg.push(',');
            msg.push_str(f);
        }
        msg.push('}');
        self.send_raw(msg.as_bytes()).await;
    }

    async fn recv(&self, buf: &mut [u8]) -> usize {
        let (n, _) = self.0.recv_from(buf).await.expect("page recv");
        n
    }
}

/// The overlay control client (see module docs; identical to the spike).
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

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn parse_secret(hex: &str) -> Option<SecretKey> {
    let hex = hex.trim();
    if hex.len() != 64 {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(SecretKey::from_bytes(&bytes))
}

fn selected_path(conn: &Connection) -> (&'static str, u64) {
    let paths = conn.paths();
    let Some(p) = paths.iter().find(|p| p.is_selected()) else {
        return ("none", 0);
    };
    let rtt = p.rtt().as_micros() as u64;
    match p.remote_addr() {
        TransportAddr::Relay(_) => ("relay", rtt),
        TransportAddr::Ip(_) => ("direct", rtt),
        _ => ("other", rtt),
    }
}

async fn run() {
    let page = Page::bind().await;

    let role = env_var("ROLE").unwrap_or_else(|| "host".into());
    let relay_mode = match env_var("RELAY") {
        Some(url) => RelayMode::custom([url.parse::<RelayUrl>().expect("RELAY url")]),
        None => RelayMode::Default,
    };
    let secret = env_var("SECRET")
        .and_then(|h| parse_secret(&h))
        .unwrap_or_else(SecretKey::generate);
    let transport_config = QuicTransportConfig::builder()
        .max_idle_timeout(Some(IDLE_TIMEOUT.try_into().expect("idle timeout")))
        .build();

    let endpoint = Endpoint::builder(presets::Minimal)
        .secret_key(secret)
        .relay_mode(relay_mode)
        .transport_config(transport_config)
        .clear_address_lookup()
        .alpns(if role == "host" {
            vec![ALPN.to_vec(), iroh_blobs::ALPN.to_vec()]
        } else {
            // The joiner accepts no sessions, but serves blobs: when it
            // sends a file, the host fetches from it.
            vec![iroh_blobs::ALPN.to_vec()]
        })
        .bind()
        .await
        .expect("bind endpoint");

    let store = MemStore::new();
    let overlay = Overlay::register(&endpoint).await;

    // Only the host needs to be online (its home relay is the session's
    // rendezvous, in the QR). The joiner dials the HOST's relay directly;
    // waiting for its own home relay would only delay the join.
    let relay_url = if role == "host" {
        endpoint.online().await;
        endpoint
            .addr()
            .addrs
            .iter()
            .find_map(|a| match a {
                TransportAddr::Relay(url) => Some(url.to_string()),
                _ => None,
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    page.event(
        "ready",
        &[
            format!("\"id\":\"{}\"", endpoint.id()),
            format!("\"relay\":\"{relay_url}\""),
        ],
    )
    .await;

    // Overlay readiness: every session's channel reports again once open;
    // re-adding the address is harmless (the configured set deduplicates).
    {
        let endpoint = endpoint.clone();
        let page = page.clone();
        tokio::spawn(async move {
            loop {
                overlay.ready().await;
                endpoint.add_external_addr(overlay.external_addr).await;
                page.event("overlay", &[format!("\"state\":\"added\"")]).await;
            }
        });
    }

    // One acceptor per endpoint: blobs connections are served by the stock
    // protocol handler in the background; session (ping-ALPN) connections
    // go to the host's session loop, or are refused while one is active
    // (and always, on the joiner).
    let (session_tx, mut session_rx) = tokio::sync::mpsc::channel::<Connection>(1);
    let session_busy = Arc::new(AtomicBool::new(false));
    {
        let endpoint = endpoint.clone();
        let blobs = BlobsProtocol::new(&store, None);
        let busy = session_busy.clone();
        let is_host = role == "host";
        tokio::spawn(async move {
            while let Some(incoming) = endpoint.accept().await {
                let Ok(conn) = incoming.await else { continue };
                if conn.alpn() == iroh_blobs::ALPN {
                    let blobs = blobs.clone();
                    tokio::spawn(async move {
                        blobs.accept(conn).await.ok();
                    });
                } else if !is_host || busy.load(Ordering::Relaxed) {
                    conn.close(1u32.into(), b"session full");
                } else {
                    session_tx.send(conn).await.ok();
                }
            }
        });
    }

    // Session loop: either side can leave and rejoin.
    if role == "host" {
        while let Some(conn) = session_rx.recv().await {
            session_busy.store(true, Ordering::Relaxed);
            session(&page, &endpoint, &store, &conn, true).await;
            session_busy.store(false, Ordering::Relaxed);
            page.event("closed", &[]).await;
        }
    } else {
        let peer: EndpointId = env_var("PEER")
            .expect("PEER required to join")
            .parse()
            .expect("parse PEER");
        let peer_relay: RelayUrl = env_var("PEER_RELAY")
            .expect("PEER_RELAY required to join")
            .parse()
            .expect("parse PEER_RELAY");
        loop {
            let addr =
                EndpointAddr::from_parts(peer, [TransportAddr::Relay(peer_relay.clone())]);
            // Bounded dial: generous enough for a slow relay handshake,
            // bounded so a hung attempt (host mid-reload) cannot stall
            // the redial loop.
            if let Ok(Ok(conn)) =
                tokio::time::timeout(Duration::from_secs(10), endpoint.connect(addr, ALPN)).await
            {
                session(&page, &endpoint, &store, &conn, false).await;
                page.event("closed", &[]).await;
            }
            tokio::time::sleep(REDIAL_DELAY).await;
        }
    }
}

/// An upload in progress: the page announced a file and streams chunks.
struct Upload {
    id: u32,
    name: String,
    size: u64,
    buf: Vec<u8>,
}

/// Fetches a blob from the session peer over a dedicated blobs-ALPN
/// connection (which rides the session's selected path), then streams the
/// verified bytes to the page.
async fn fetch_and_deliver(
    endpoint: Endpoint,
    store: MemStore,
    peer: EndpointId,
    hash_hex: String,
    size: u64,
    page: Page,
) {
    let fail = |page: Page, msg: String| async move {
        page.event("file-error", &[format!("\"msg\":\"{msg}\"")]).await;
    };
    let Ok(hash) = hash_hex.parse::<iroh_blobs::Hash>() else {
        return fail(page, "bad hash".into()).await;
    };
    // No addresses: the live session already gave iroh a path to the peer.
    let addr = EndpointAddr::from_parts(peer, []);
    let conn = match endpoint.connect(addr, iroh_blobs::ALPN).await {
        Ok(conn) => conn,
        Err(err) => return fail(page, format!("connect: {err}")).await,
    };

    use n0_future::StreamExt;
    let mut progress = store.remote().fetch(conn.clone(), hash).stream();
    let mut last = Instant::now();
    loop {
        match progress.next().await {
            Some(iroh_blobs::api::remote::GetProgressItem::Progress(done)) => {
                if last.elapsed() > Duration::from_millis(200) {
                    last = Instant::now();
                    page.event(
                        "progress",
                        &[
                            format!("\"hash\":\"{hash}\""),
                            format!("\"done\":{done}"),
                            format!("\"total\":{size}"),
                        ],
                    )
                    .await;
                }
            }
            Some(iroh_blobs::api::remote::GetProgressItem::Done(_)) => break,
            Some(iroh_blobs::api::remote::GetProgressItem::Error(err)) => {
                return fail(page, format!("fetch: {err}")).await;
            }
            None => return fail(page, "fetch ended early".into()).await,
        }
    }
    conn.close(0u32.into(), b"done");

    let bytes = match store.get_bytes(hash).await {
        Ok(bytes) => bytes,
        Err(err) => return fail(page, format!("read: {err}")).await,
    };
    page.event(
        "file-start",
        &[
            format!("\"hash\":\"{hash}\""),
            format!("\"size\":{}", bytes.len()),
        ],
    )
    .await;
    let mut frame = Vec::with_capacity(1 + DOWN_CHUNK);
    for chunk in bytes.chunks(DOWN_CHUNK) {
        frame.clear();
        frame.push(TAG_DOWN_CHUNK);
        frame.extend_from_slice(chunk);
        page.send_raw(&frame).await;
    }
    page.event("file-done", &[format!("\"hash\":\"{hash}\"")]).await;
}

/// One session: stream setup, then the ferry until the connection ends or
/// the page says bye (an empty datagram). Upload chunks and the
/// send/fetch commands are intercepted here; everything else ferries.
async fn session(page: &Page, endpoint: &Endpoint, store: &MemStore, conn: &Connection, host: bool) {
    let remote = conn.remote_id();
    page.event("connected", &[format!("\"peer\":\"{remote}\"")])
        .await;

    // The joiner opens the ferry stream; the host accepts it. An empty
    // frame makes the fresh stream visible to the acceptor — QUIC streams
    // do not exist on the remote until bytes flow.
    let streams = if host {
        conn.accept_bi().await.ok()
    } else {
        match conn.open_bi().await {
            Ok((mut send, recv)) => send
                .write_all(&0u16.to_be_bytes())
                .await
                .ok()
                .map(|()| (send, recv)),
            Err(_) => None,
        }
    };
    let Some((mut stream_send, mut stream_recv)) = streams else {
        // Refused ("session full") or lost during setup; the caller loops.
        return;
    };

    // Peer -> page: length-framed stream to raw datagrams.
    let reader = {
        let page = page.clone();
        tokio::spawn(async move {
            let mut len = [0u8; 2];
            let mut buf = vec![0u8; MAX_FRAME];
            loop {
                if stream_recv.read_exact(&mut len).await.is_err() {
                    break;
                }
                let n = u16::from_be_bytes(len) as usize;
                if n > MAX_FRAME || stream_recv.read_exact(&mut buf[..n]).await.is_err() {
                    break;
                }
                page.send_raw(&buf[..n]).await;
            }
        })
    };

    // Path watcher: report the selected path whenever it changes.
    let watcher = {
        let conn = conn.clone();
        let page = page.clone();
        tokio::spawn(async move {
            let mut last = ("", 0u64);
            loop {
                let (path, rtt) = selected_path(&conn);
                if path != last.0 || rtt.abs_diff(last.1) > 500 {
                    last = (path, rtt);
                    page.event(
                        "path",
                        &[
                            format!("\"path\":\"{path}\""),
                            format!("\"rtt_us\":{rtt}"),
                        ],
                    )
                    .await;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        })
    };

    // Page -> peer: raw datagrams to length-framed stream, until the
    // connection ends or the page says bye. Upload chunks and the two
    // page commands are intercepted rather than ferried.
    let mut buf = vec![0u8; MAX_FRAME];
    let mut upload: Option<Upload> = None;
    loop {
        tokio::select! {
            n = page.recv(&mut buf) => {
                if n == 0 {
                    conn.close(0u32.into(), b"bye");
                    break;
                }
                let frame = &buf[..n];
                if frame[0] == TAG_UP_CHUNK {
                    let Some(u) = upload.as_mut() else { continue };
                    u.buf.extend_from_slice(&frame[1..]);
                    if u.buf.len() as u64 >= u.size {
                        let u = upload.take().expect("upload present");
                        match store.add_bytes(u.buf).await {
                            Ok(tag) => {
                                page.event(
                                    "added",
                                    &[
                                        format!("\"id\":{}", u.id),
                                        format!("\"hash\":\"{}\"", tag.hash),
                                        format!("\"size\":{}", u.size),
                                    ],
                                )
                                .await;
                            }
                            Err(err) => {
                                page.event(
                                    "file-error",
                                    &[format!("\"msg\":\"add: {err}\"")],
                                )
                                .await;
                            }
                        }
                    }
                    continue;
                }
                if let Ok(cmd) = serde_json::from_slice::<PageCommand>(frame) {
                    match cmd {
                        PageCommand::Send { id, name, size } => {
                            upload = Some(Upload {
                                id,
                                name,
                                size,
                                buf: Vec::with_capacity(size as usize),
                            });
                            tracing::debug!("upload started: {} ({size} bytes)", upload.as_ref().map(|u| u.name.as_str()).unwrap_or(""));
                        }
                        PageCommand::Fetch { hash, size } => {
                            tokio::spawn(fetch_and_deliver(
                                endpoint.clone(),
                                store.clone(),
                                remote,
                                hash,
                                size,
                                page.clone(),
                            ));
                        }
                    }
                    continue;
                }
                if stream_send.write_all(&(n as u16).to_be_bytes()).await.is_err()
                    || stream_send.write_all(frame).await.is_err()
                {
                    break;
                }
            }
            _ = conn.closed() => break,
        }
    }

    reader.abort();
    watcher.abort();
}
