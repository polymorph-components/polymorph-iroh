//! The endpoint demo: a plain consumer of `polymorph:iroh/endpoint`, composed
//! with the endpoint component via `wac plug`. It exercises the surface
//! exactly the way an application protocol would: bind, connect or accept
//! by endpoint ID, one bidirectional stream, one echo each way.

use std::io::Write;
use std::pin::pin;
use std::time::Instant;

use futures::FutureExt;

mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "iroh-demo",
        generate_all,
        // The webcrypto interfaces are bound once in polymorph-webcrypto-guest
        // (this crate mints the injected identity through it); the
        // `signature` handles it wraps must be the same resource types
        // the endpoint import names.
        with: {
            "polymorph:webcrypto/types@0.1.0": polymorph_webcrypto_guest::bindings::types,
            "polymorph:webcrypto/wrapping@0.1.0": polymorph_webcrypto_guest::bindings::wrapping,
            "polymorph:webcrypto/signature@0.1.0": polymorph_webcrypto_guest::bindings::signature,
        },
    });
}

use bindings::exports::polymorph::iroh_demo::demo::{Guest, Role, RunConfig, RunReport};
use bindings::polymorph::iroh::endpoint::{Connection, Endpoint, EndpointOptions, RecvStream};
use bindings::polymorph::iroh::identity_from_keys::from_keys;
use bindings::polymorph::iroh::identity_generate::generate;
use bindings::polymorph::iroh::types::{CloseInfo, EndpointAddr, Error, PathKind, TransportAddr};
use bindings::wasi::clocks::monotonic_clock;
use polymorph_webcrypto_guest::{ecdsa, ed25519, SigningKeyOptions};
use wit_bindgen::rt::async_support::StreamReader;

/// The demo's ALPN protocol.
const ALPN: &[u8] = b"iroh-demo/0";

/// The application close the client sends when its exchange is done.
/// The server asserts this exact close arrives through `wait-closed`,
/// so the demo gates the close-info plumbing end to end; the values are
/// mirrored in `tools/iroh-peer` (the upstream interop peer plays both
/// sides of the same assertion).
const CLOSE_CODE: u64 = 17;
const CLOSE_REASON: &str = "demo done";

/// Cap on one read call; the demo's payloads are tiny.
const READ_MAX: u32 = 16 * 1024;

/// Copies of the demo datagram sent (client) and of its echo (server):
/// datagrams are lossy by contract, and duplication makes the exchange
/// robust without either side cancelling a pending receive (an
/// in-flight import subtask must resolve — the jco discipline).
const DATAGRAM_COPIES: usize = 3;

/// Polling quantum and bound for the demo's bounded waits: the WebRTC
/// upgrade and the datagram-ceiling rise (both discovered in the
/// background over the connection's first round trips).
const POLL_NS: u64 = 5_000_000;
const DEADLINE_POLLS: u32 = 30_000 / 5;

struct Component;

impl Guest for Component {
    async fn run(config: RunConfig) -> Result<RunReport, String> {
        if config.identity_negative {
            return run_identity_negative().await;
        }
        if config.backlog_negative {
            return run_backlog_negative(&config).await;
        }

        // The identity is explicit: constructed through one of the
        // constructor interfaces, then handed to the options. The
        // inject-identity path exercises from-keys (webcrypto handles
        // crossing the composition); the default path exercises
        // generate.
        let identity = if config.inject_identity {
            let (signing, verifying) = ed25519::generate_key(SigningKeyOptions {
                sign: true,
                extractable: false,
            })
            .await
            .map_err(|e| format!("mint identity keys: {e}"))?;
            from_keys(signing.into_raw(), verifying.into_raw())
                .await
                .map_err(fail("from-keys"))?
        } else {
            generate().await.map_err(fail("generate"))?
        };
        let expected_id = identity.endpoint_id();

        let options = EndpointOptions::new(&identity);
        options.add_alpn(ALPN);
        options.relay_url(&config.relay_url);
        if let Some(udp_bind) = &config.udp_bind {
            options.udp_bind_addr(udp_bind);
        }
        options.webrtc(config.webrtc);
        let endpoint = Endpoint::bind(options).await.map_err(fail("bind"))?;

        if endpoint.id() != expected_id {
            return Err("bind did not adopt the supplied identity".into());
        }

        // The driver hands this ID to the peer process.
        println!("endpoint-id {}", hex::encode(endpoint.id()));
        // And this address to a peer that should dial direct.
        if let Some(addr) = endpoint.direct_addr() {
            println!("direct-addr {addr}");
        }
        let _ = std::io::stdout().flush();

        let report = match config.role {
            Role::Client if config.stream_negative => {
                stream_negative_client(&endpoint, &config).await?
            }
            Role::Server if config.stream_negative => stream_negative_server(&endpoint).await?,
            Role::Client => run_client(&endpoint, &config).await?,
            Role::Server => run_server(&endpoint, &config).await?,
        };

        endpoint.close();
        Ok(RunReport {
            endpoint_id: hex::encode(endpoint.id()),
            ..report
        })
    }
}

async fn run_client(endpoint: &Endpoint, config: &RunConfig) -> Result<RunReport, String> {
    let peer_hex = config
        .peer
        .as_ref()
        .ok_or("the client role requires the server's endpoint id (peer)")?;
    let peer = hex::decode(peer_hex).map_err(|e| format!("bad endpoint id: {e}"))?;

    let alpn = config
        .alpn
        .as_ref()
        .map(|a| a.as_bytes().to_vec())
        .unwrap_or_else(|| ALPN.to_vec());
    let peer_relay = config
        .peer_relay
        .clone()
        .unwrap_or_else(|| config.relay_url.clone());
    let mut addrs = Vec::new();
    if let Some(direct) = &config.direct {
        addrs.push(TransportAddr::Ip(direct.clone()));
    }
    if config.webrtc {
        addrs.push(TransportAddr::Webrtc(peer_relay.clone()));
    }
    addrs.push(TransportAddr::Relay(peer_relay.clone()));
    let started = Instant::now();
    let conn = endpoint
        .connect(
            EndpointAddr {
                endpoint_id: peer.clone(),
                addrs,
            },
            alpn,
        )
        .await
        .map_err(fail("connect"))?;
    let handshake_ms = started.elapsed().as_millis() as u64;

    // The upgrade runs in the background; this demo exists to exercise
    // the wire it asked for, so follow the path watch to the flip,
    // bounded.
    if config.webrtc {
        let mut changes = conn.path_changes();
        let watch = async move {
            loop {
                let (result, kinds) = changes.read(Vec::with_capacity(4)).await;
                if kinds.contains(&PathKind::Webrtc) {
                    return Ok(());
                }
                if !matches!(result, wit_bindgen::StreamResult::Complete(_)) {
                    return Err("the path watch ended before the upgrade".to_string());
                }
            }
        };
        let mut watch = pin!(watch.fuse());
        let mut deadline = pin!(monotonic_clock::wait_for(30_000_000_000).fuse());
        futures::select_biased! {
            r = watch => r?,
            _ = deadline => return Err("webrtc upgrade did not complete".into()),
        }
    }

    let (send, recv) = conn.open_bi().await.map_err(fail("open-bi"))?;
    let payload = match config.payload_bytes {
        Some(bytes) => vec![0u8; bytes as usize],
        None => config.message.clone().into_bytes(),
    };
    let payload_len = payload.len();
    let sent_at = Instant::now();
    send.write(payload).await.map_err(fail("write"))?;
    send.finish().map_err(fail("finish"))?;

    let mut echoed = Vec::new();
    while let Some(chunk) = recv.read(READ_MAX).await.map_err(fail("read"))? {
        echoed.extend_from_slice(&chunk);
    }
    let roundtrip_ms = sent_at.elapsed().as_millis() as u64;
    if echoed.len() != payload_len {
        return Err(format!(
            "echo length mismatch: sent {payload_len}, got {}",
            echoed.len()
        ));
    }

    // The datagram leg: send after the stream echo (the connection and
    // its path are settled), then wait for the server's echo.
    let datagram = if config.datagram {
        Some(run_client_datagram(&conn, config).await?)
    } else {
        None
    };
    let path = path_name(conn.path());

    conn.close(CLOSE_CODE, CLOSE_REASON);
    // A locally initiated close carries no peer close-info.
    if let Some(info) = conn.wait_closed().await {
        return Err(format!(
            "locally closed connection reported a peer close: {info:?}"
        ));
    }

    let received = match config.payload_bytes {
        Some(_) => format!("{} bytes", echoed.len()),
        None => String::from_utf8_lossy(&echoed).into_owned(),
    };
    Ok(RunReport {
        endpoint_id: String::new(),
        peer_id: hex::encode(conn.peer()),
        path,
        handshake_ms,
        roundtrip_ms,
        received,
        datagram,
    })
}

/// The client's datagram echo: send `DATAGRAM_COPIES` copies, await one
/// echo, assert it round-tripped verbatim.
///
/// With `datagram-ceiling` set, first wait (bounded) for
/// `max-datagram-size` to reach it — the ceiling is discovered per
/// path and rises over the first round trips — then probe with a
/// patterned datagram of exactly that size, gating the raised ceiling
/// end to end.
async fn run_client_datagram(conn: &Connection, config: &RunConfig) -> Result<String, String> {
    let payload = match config.datagram_ceiling {
        Some(bytes) => {
            await_datagram_ceiling(conn, bytes).await?;
            // A patterned payload: a truncated or corrupted echo
            // cannot pass the equality check below.
            (0..bytes).map(|i| (i % 251) as u8).collect()
        }
        None => format!("datagram {}", config.message).into_bytes(),
    };
    let max = conn
        .max_datagram_size()
        .ok_or("peer does not accept datagrams")?;
    if payload.len() > max as usize {
        return Err(format!(
            "demo datagram ({} bytes) exceeds max-datagram-size ({max})",
            payload.len()
        ));
    }
    for _ in 0..DATAGRAM_COPIES {
        conn.send_datagram(&payload)
            .map_err(fail("send-datagram"))?;
    }
    let echoed = conn.recv_datagram().await.map_err(fail("recv-datagram"))?;
    if echoed != payload {
        return Err(format!(
            "datagram echo mismatch: sent {} bytes, got {} bytes",
            payload.len(),
            echoed.len()
        ));
    }
    Ok(datagram_summary(&echoed))
}

/// Wait (bounded) for this side's `max-datagram-size` to reach `bytes`.
///
/// The ceiling is discovered per path AND per direction: each side's
/// send limit converges on its own schedule, so a payload that fit the
/// sender's ceiling may not fit this side's yet (the echo path hits
/// exactly that).
async fn await_datagram_ceiling(conn: &Connection, bytes: u32) -> Result<(), String> {
    let mut polls = 0;
    while conn.max_datagram_size().unwrap_or(0) < bytes {
        polls += 1;
        if polls > DEADLINE_POLLS {
            return Err(format!(
                "max-datagram-size stalled at {:?}, needed {bytes}",
                conn.max_datagram_size()
            ));
        }
        monotonic_clock::wait_for(POLL_NS).await;
    }
    Ok(())
}

async fn run_server(endpoint: &Endpoint, config: &RunConfig) -> Result<RunReport, String> {
    let conn = endpoint.accept().await.map_err(fail("accept"))?;
    let (send, recv) = conn.accept_bi().await.map_err(fail("accept-bi"))?;

    let mut inbound = Vec::new();
    while let Some(chunk) = recv.read(READ_MAX).await.map_err(fail("read"))? {
        inbound.extend_from_slice(&chunk);
    }

    // The uppercase transform is a small-message affordance; bulk
    // payloads echo verbatim and report a summary, not megabytes.
    const SUMMARY_LIMIT: usize = 4096;
    let (echo, received) = if inbound.len() <= SUMMARY_LIMIT {
        let text = String::from_utf8_lossy(&inbound).into_owned();
        (text.to_uppercase().into_bytes(), text)
    } else {
        let summary = format!("{} bytes", inbound.len());
        (inbound, summary)
    };
    send.write(echo).await.map_err(fail("write"))?;
    send.finish().map_err(fail("finish"))?;

    // The datagram leg: receive one (the client sends copies), echo it
    // verbatim in copies of our own. This side's send ceiling converges
    // independently of the sender's, so wait for it to cover the echo.
    let datagram = if config.datagram {
        let payload = conn.recv_datagram().await.map_err(fail("recv-datagram"))?;
        await_datagram_ceiling(&conn, payload.len() as u32).await?;
        for _ in 0..DATAGRAM_COPIES {
            conn.send_datagram(&payload)
                .map_err(fail("send-datagram"))?;
        }
        Some(datagram_summary(&payload))
    } else {
        None
    };
    let path = path_name(conn.path());

    // The client closes once it has its echo; that close is the demo's
    // natural end on this side, and `wait-closed` must surface its
    // exact code and reason.
    match conn.wait_closed().await {
        Some(CloseInfo { code, reason }) if code == CLOSE_CODE && reason == CLOSE_REASON => {}
        other => {
            return Err(format!(
                "expected the client's close ({CLOSE_CODE}, {CLOSE_REASON:?}), got: {other:?}"
            ))
        }
    }

    Ok(RunReport {
        endpoint_id: String::new(),
        peer_id: hex::encode(conn.peer()),
        path,
        handshake_ms: 0,
        roundtrip_ms: 0,
        received,
        datagram,
    })
}

/// Mint one non-extractable Ed25519 signing pair.
async fn mint_pair(
    what: &str,
) -> Result<
    (
        polymorph_webcrypto_guest::SigningKey,
        polymorph_webcrypto_guest::VerifyingKey,
    ),
    String,
> {
    ed25519::generate_key(SigningKeyOptions {
        sign: true,
        extractable: false,
    })
    .await
    .map_err(|e| format!("mint {what}: {e}"))
}

/// The `identity-from-keys` failure-path probes (see the `run-config`
/// field doc). Every assertion is in-guest; a passing run reports the
/// control identity's endpoint-id and performs no bind.
async fn run_identity_negative() -> Result<RunReport, String> {
    // Control: a matched pair constructs, and the identity reports the
    // pair's public key — proving the rejections below are judgments,
    // not environmental failures.
    let (signing, verifying) = mint_pair("control pair").await?;
    let expected = verifying
        .export_key_raw()
        .await
        .map_err(|e| format!("export control public key: {e}"))?;
    let control = from_keys(signing.into_raw(), verifying.into_raw())
        .await
        .map_err(fail("from-keys (control)"))?;
    if control.endpoint_id() != expected {
        return Err("control identity does not report the pair's public key".into());
    }

    // A mismatched pair: the signing key of one pair, the verifying key
    // of another. The possession probe must reject it.
    let (signing, _verifying) = mint_pair("mismatch pair a").await?;
    let (_signing, verifying) = mint_pair("mismatch pair b").await?;
    match from_keys(signing.into_raw(), verifying.into_raw()).await {
        Err(Error::InvalidArgument(_)) => {}
        Ok(_) => return Err("from-keys accepted a mismatched pair".into()),
        Err(other) => {
            return Err(format!(
                "from-keys rejected a mismatched pair with the wrong error: {other:?}"
            ))
        }
    }

    // A non-Ed25519 pair: matched halves, wrong algorithm.
    let (signing, verifying) = ecdsa::generate_key(
        ecdsa::EcdsaVariant::P256Sha256,
        SigningKeyOptions {
            sign: true,
            extractable: false,
        },
    )
    .await
    .map_err(|e| format!("mint ecdsa pair: {e}"))?;
    match from_keys(signing.into_raw(), verifying.into_raw()).await {
        Err(Error::InvalidArgument(_)) => {}
        Ok(_) => return Err("from-keys accepted an ECDSA pair".into()),
        Err(other) => {
            return Err(format!(
                "from-keys rejected an ECDSA pair with the wrong error: {other:?}"
            ))
        }
    }

    Ok(RunReport {
        endpoint_id: hex::encode(control.endpoint_id()),
        peer_id: String::new(),
        path: String::new(),
        handshake_ms: 0,
        roundtrip_ms: 0,
        received: "identity negative probes passed".into(),
        datagram: None,
    })
}

fn path_name(path: PathKind) -> String {
    match path {
        PathKind::Relay => "relay",
        PathKind::Ip => "ip",
        PathKind::Webrtc => "webrtc",
    }
    .to_string()
}

/// Render a datagram payload for the report: short text verbatim, bulk
/// (or non-text) as a length.
fn datagram_summary(payload: &[u8]) -> String {
    match std::str::from_utf8(payload) {
        Ok(text) if payload.len() <= 256 => text.to_string(),
        _ => format!("{} bytes", payload.len()),
    }
}

/// The stream-integrity probes' fixed codes (issue #13, findings
/// A1/A2). Deliberately above the u32 range: a passing run asserts
/// application codes cross the surface u62-faithfully (finding A3),
/// not truncated.
const STREAM_RESET_CODE: u64 = (1 << 40) + 77;
const STREAM_VIA_RESET_CODE: u64 = (1 << 41) + 78;
const STREAM_WRITE_CANCEL_CODE: u64 = (1 << 39) + 7;
const STREAM_CLOSE_CODE: u64 = (1 << 42) + 9;
const STREAM_CLOSE_REASON: &str = "cut";

/// Sized past the peer's stream flow-control window, so an unread
/// write parks deterministically (the exclusion and cancellation
/// probes need an in-flight write).
const PARKED_WRITE_BYTES: usize = 2 * 1024 * 1024;

/// Drain `recv` with `read` until its terminal outcome: `Ok` at the
/// peer's FIN, the failure otherwise.
async fn read_until_terminal(recv: &RecvStream) -> Result<(), Error> {
    loop {
        match recv.read(READ_MAX).await {
            Ok(Some(_)) => {}
            Ok(None) => return Ok(()),
            Err(err) => return Err(err),
        }
    }
}

/// Collect a byte stream until it ends (however it ends: the paired
/// future tells).
async fn drain(mut data: StreamReader<u8>) -> Vec<u8> {
    let mut all = Vec::new();
    loop {
        let (result, buf) = data.read(Vec::with_capacity(READ_MAX as usize)).await;
        all.extend_from_slice(&buf);
        match result {
            wit_bindgen::StreamResult::Complete(_) => {}
            wit_bindgen::StreamResult::Dropped | wit_bindgen::StreamResult::Cancelled => break,
        }
    }
    all
}

/// The client half of the stream-integrity probes. Two cancelled
/// dials first (nothing may leak or wedge), then one stream per
/// terminal-outcome assertion: a peer reset and a connection close
/// must surface on `read` and on `read-via-stream`'s future — never
/// as a clean FIN — dropped resources have their documented wire
/// effects, and the in-flight guards refuse concurrent use.
async fn stream_negative_client(
    endpoint: &Endpoint,
    config: &RunConfig,
) -> Result<RunReport, String> {
    let peer_hex = config
        .peer
        .as_ref()
        .ok_or("the client role requires the server's endpoint id (peer)")?;
    let peer = hex::decode(peer_hex).map_err(|e| format!("bad endpoint id: {e}"))?;

    // S0 — cancelling `connect` leaks nothing (finding B5). (a) dials
    // an absent peer through the home relay: the entry parks in the
    // handshake and the cancel must close it. (b) dials through a
    // blackhole relay: the cancel must release the relay-open claim —
    // a wedged claim would starve every later dial of that relay. The
    // rest of the suite completing is the no-wedge assertion.
    let absent = generate().await.map_err(fail("mint absent peer"))?;
    let probes: [(&str, Vec<TransportAddr>, bool); 2] = [
        (
            "absent peer",
            vec![TransportAddr::Relay(config.relay_url.clone())],
            false,
        ),
        (
            "blackhole relay",
            vec![TransportAddr::Relay("http://203.0.113.1:9".into())],
            true,
        ),
    ];
    for (label, addrs, may_fail_fast) in probes {
        let dial = endpoint.connect(
            EndpointAddr {
                endpoint_id: absent.endpoint_id(),
                addrs,
            },
            ALPN.to_vec(),
        );
        let mut dial = pin!(dial.fuse());
        let mut timer = pin!(monotonic_clock::wait_for(100_000_000).fuse());
        futures::select_biased! {
            // Dropping `dial` here is the cancellation under test.
            _ = timer => {}
            r = dial => match r {
                Ok(_) => return Err(format!("s0 {label}: the dial resolved")),
                Err(err) if may_fail_fast => {
                    // An unroutable relay may fail fast instead of
                    // parking; the claim releases through the normal
                    // error path then.
                    let _ = err;
                }
                Err(err) => return Err(format!("s0 {label}: the dial failed early: {err:?}")),
            },
        }
    }

    let started = Instant::now();
    let conn = endpoint
        .connect(
            EndpointAddr {
                endpoint_id: peer,
                addrs: vec![TransportAddr::Relay(config.relay_url.clone())],
            },
            ALPN.to_vec(),
        )
        .await
        .map_err(fail("connect"))?;
    let handshake_ms = started.elapsed().as_millis() as u64;

    // S1 — a peer reset surfaces on `read`, and is latched.
    let (send, recv) = conn.open_bi().await.map_err(fail("open-bi s1"))?;
    send.write(b"reset-me".to_vec())
        .await
        .map_err(fail("write s1"))?;
    send.finish().map_err(fail("finish s1"))?;
    match read_until_terminal(&recv).await {
        Err(Error::Reset(code)) if code == STREAM_RESET_CODE => {}
        other => {
            return Err(format!(
                "s1: expected reset {STREAM_RESET_CODE}, got {other:?}"
            ))
        }
    }
    match recv.read(READ_MAX).await {
        Err(Error::Reset(code)) if code == STREAM_RESET_CODE => {}
        other => return Err(format!("s1: reset not latched; second read got {other:?}")),
    }

    // S2 — read-via-stream: the FIN resolves the future ok.
    let (send, recv) = conn.open_bi().await.map_err(fail("open-bi s2"))?;
    send.write(b"fin-me".to_vec())
        .await
        .map_err(fail("write s2"))?;
    send.finish().map_err(fail("finish s2"))?;
    let (data, done) = recv.read_via_stream().map_err(fail("read-via-stream s2"))?;
    let bytes = drain(data).await;
    match done.await {
        Ok(()) if bytes == b"fin" => {}
        Ok(()) => return Err(format!("s2: clean end with wrong bytes: {bytes:?}")),
        Err(err) => return Err(format!("s2: expected a clean end, got {err:?}")),
    }

    // S3 — read-via-stream: a reset resolves the future with it. The
    // bytes before the reset are QUIC's to discard; only the outcome
    // is asserted.
    let (send, recv) = conn.open_bi().await.map_err(fail("open-bi s3"))?;
    send.write(b"reset-stream-me".to_vec())
        .await
        .map_err(fail("write s3"))?;
    send.finish().map_err(fail("finish s3"))?;
    let (data, done) = recv.read_via_stream().map_err(fail("read-via-stream s3"))?;
    let _partial = drain(data).await;
    match done.await {
        Err(Error::Reset(code)) if code == STREAM_VIA_RESET_CODE => {}
        other => {
            return Err(format!(
                "s3: expected reset {STREAM_VIA_RESET_CODE}, got {other:?}"
            ))
        }
    }

    // S4 — a dropped send half has its documented wire effect: the
    // server must read `reset(0)`, never a clean FIN.
    let (send, recv) = conn.open_bi().await.map_err(fail("open-bi s4"))?;
    send.write(b"drop-me".to_vec())
        .await
        .map_err(fail("write s4"))?;
    drop(send);
    drop(recv);

    // S5 — a dropped recv half implies `stop(0)`: the server's writes
    // onto this stream must fail with reset 0.
    let (send, recv) = conn.open_bi().await.map_err(fail("open-bi s5"))?;
    send.write(b"stop-me".to_vec())
        .await
        .map_err(fail("write s5"))?;
    send.finish().map_err(fail("finish s5"))?;
    drop(recv);

    // S6 — the write path refuses concurrent use, and a cancelled
    // write releases the guard. The oversized write parks against the
    // unread window; a second write and a finish are refused while it
    // is in flight; dropping its future is the cancellation, and
    // `reset` is the documented recovery.
    let send = conn.open_uni().await.map_err(fail("open-uni s6"))?;
    {
        let mut parked = pin!(send.write(vec![0u8; PARKED_WRITE_BYTES]).fuse());
        if futures::poll!(parked.as_mut()).is_ready() {
            return Err("s6: the oversized write did not park".into());
        }
        monotonic_clock::wait_for(50_000_000).await;
        if futures::poll!(parked.as_mut()).is_ready() {
            return Err("s6: the oversized write completed against an unread stream".into());
        }
        match send.write(b"x".to_vec()).await {
            Err(Error::Other(msg)) if msg.contains("in flight") => {}
            other => return Err(format!("s6: concurrent write not refused: {other:?}")),
        }
        match send.finish() {
            Err(Error::Other(msg)) if msg.contains("in flight") => {}
            other => return Err(format!("s6: finish under a write not refused: {other:?}")),
        }
        // Dropping the parked future cancels the write: a prefix is
        // committed, the guard releases.
    }
    send.reset(STREAM_WRITE_CANCEL_CODE);

    // S7 — the read path refuses concurrent use, and a cancelled read
    // releases the guard. The server stays silent on this stream.
    let (send, recv) = conn.open_bi().await.map_err(fail("open-bi s7"))?;
    send.write(b"ready-s7".to_vec())
        .await
        .map_err(fail("write s7"))?;
    send.finish().map_err(fail("finish s7"))?;
    {
        let mut parked = pin!(recv.read(READ_MAX).fuse());
        if futures::poll!(parked.as_mut()).is_ready() {
            return Err("s7: the read did not park on a silent stream".into());
        }
        match recv.read(READ_MAX).await {
            Err(Error::Other(msg)) if msg.contains("in flight") => {}
            other => return Err(format!("s7: concurrent read not refused: {other:?}")),
        }
        // Dropping the parked future cancels the read and releases
        // the guard; the post-close read below proves both.
    }

    // S8 — a connection close under an unfinished stream surfaces as
    // `error.closed`, never as a clean FIN; the close itself stays
    // readable through `wait-closed`.
    let (send, recv8) = conn.open_bi().await.map_err(fail("open-bi s8"))?;
    send.write(b"close-me".to_vec())
        .await
        .map_err(fail("write s8"))?;
    send.finish().map_err(fail("finish s8"))?;
    let path = path_name(conn.path());
    match read_until_terminal(&recv8).await {
        Err(Error::Closed) => {}
        other => return Err(format!("s8: expected closed, got {other:?}")),
    }
    match conn.wait_closed().await {
        Some(CloseInfo { code, reason })
            if code == STREAM_CLOSE_CODE && reason == STREAM_CLOSE_REASON => {}
        other => return Err(format!("s8: expected the server's close, got {other:?}")),
    }
    // The cancelled S7 read released its guard: a later read runs and
    // reports the connection's failure, not a refusal.
    match recv.read(READ_MAX).await {
        Err(Error::Other(msg)) if msg.contains("in flight") => {
            return Err("s7: the cancelled read left its guard claimed".into())
        }
        Err(_) => {}
        other => return Err(format!("s7: post-close read got {other:?}")),
    }

    Ok(RunReport {
        endpoint_id: String::new(),
        peer_id: hex::encode(conn.peer()),
        path,
        handshake_ms,
        roundtrip_ms: 0,
        received: "stream negative probes passed".into(),
        datagram: None,
    })
}

/// The server half of the stream-integrity probes: reset, answer,
/// partially answer, then close the connection under an unfinished
/// stream.
async fn stream_negative_server(endpoint: &Endpoint) -> Result<RunReport, String> {
    let conn = endpoint.accept().await.map_err(fail("accept"))?;

    // S1: take the request, then abandon the send half.
    let (send, recv) = conn.accept_bi().await.map_err(fail("accept-bi s1"))?;
    read_until_terminal(&recv).await.map_err(fail("read s1"))?;
    send.reset(STREAM_RESET_CODE);

    // S2: answer and finish cleanly.
    let (send, recv) = conn.accept_bi().await.map_err(fail("accept-bi s2"))?;
    read_until_terminal(&recv).await.map_err(fail("read s2"))?;
    send.write(b"fin".to_vec())
        .await
        .map_err(fail("write s2"))?;
    send.finish().map_err(fail("finish s2"))?;

    // S3: a partial answer, then the reset.
    let (send, recv) = conn.accept_bi().await.map_err(fail("accept-bi s3"))?;
    read_until_terminal(&recv).await.map_err(fail("read s3"))?;
    send.write(b"par".to_vec())
        .await
        .map_err(fail("write s3"))?;
    send.reset(STREAM_VIA_RESET_CODE);

    // S4: the client dropped its send half unfinished; the drop
    // contract delivers reset(0), never a clean FIN.
    let (_send, recv) = conn.accept_bi().await.map_err(fail("accept-bi s4"))?;
    match read_until_terminal(&recv).await {
        Err(Error::Reset(0)) => {}
        other => return Err(format!("s4: expected the drop's reset(0), got {other:?}")),
    }

    // S5: the client dropped its recv half; the implied stop(0) must
    // fail our writes with reset 0.
    let (send, recv) = conn.accept_bi().await.map_err(fail("accept-bi s5"))?;
    read_until_terminal(&recv).await.map_err(fail("read s5"))?;
    let mut stopped = None;
    for _ in 0..512 {
        match send.write(vec![0u8; 16 * 1024]).await {
            Ok(()) => {}
            Err(err) => {
                stopped = Some(err);
                break;
            }
        }
    }
    match stopped {
        Some(Error::Reset(0)) => {}
        other => return Err(format!("s5: expected the stop's reset(0), got {other:?}")),
    }

    // S6: accepted and deliberately never read — the client's
    // oversized write must park against this window. Its terminal
    // read happens after S7 arrives, by which time the client has
    // cancelled the write and reset the stream.
    let recv6 = conn.accept_uni().await.map_err(fail("accept-uni s6"))?;

    // S7: accepted and held silent — the client parks a read on it.
    let (_send7, recv7) = conn.accept_bi().await.map_err(fail("accept-bi s7"))?;
    read_until_terminal(&recv7).await.map_err(fail("read s7"))?;
    match read_until_terminal(&recv6).await {
        Err(Error::Reset(code)) if code == STREAM_WRITE_CANCEL_CODE => {}
        other => {
            return Err(format!(
                "s6: expected reset {STREAM_WRITE_CANCEL_CODE}, got {other:?}"
            ))
        }
    }

    // S8: leave the stream unfinished and close the connection under
    // it.
    let (send, recv) = conn.accept_bi().await.map_err(fail("accept-bi s8"))?;
    read_until_terminal(&recv).await.map_err(fail("read s8"))?;
    send.write(b"tail".to_vec())
        .await
        .map_err(fail("write s8"))?;
    let path = path_name(conn.path());
    let peer = hex::encode(conn.peer());
    conn.close(STREAM_CLOSE_CODE, STREAM_CLOSE_REASON);
    if let Some(info) = conn.wait_closed().await {
        return Err(format!(
            "locally closed connection reported a peer close: {info:?}"
        ));
    }

    Ok(RunReport {
        endpoint_id: String::new(),
        peer_id: peer,
        path,
        handshake_ms: 0,
        roundtrip_ms: 0,
        received: "stream negative probes passed".into(),
        datagram: None,
    })
}

fn fail(what: &'static str) -> impl Fn(Error) -> String {
    move |err| format!("{what}: {err:?}")
}

/// Mirrors the endpoint's accept backlog (`ACCEPT_BACKLOG` in
/// endpoint/src/endpoint_impl.rs); the probe asserts refusal exactly
/// past it, so a drift fails the gate loudly.
const ACCEPT_BACKLOG: usize = 16;

/// The accept-backlog probes (issue #13, finding B7), single-process:
/// a victim endpoint that never accepts, and a prober that dials it.
async fn run_backlog_negative(config: &RunConfig) -> Result<RunReport, String> {
    let victim_identity = generate().await.map_err(fail("generate victim"))?;
    let options = EndpointOptions::new(&victim_identity);
    options.add_alpn(ALPN);
    options.relay_url(&config.relay_url);
    let victim = Endpoint::bind(options).await.map_err(fail("bind victim"))?;
    let prober_identity = generate().await.map_err(fail("generate prober"))?;
    let options = EndpointOptions::new(&prober_identity);
    options.add_alpn(ALPN);
    options.relay_url(&config.relay_url);
    let prober = Endpoint::bind(options).await.map_err(fail("bind prober"))?;

    let victim_addr = || EndpointAddr {
        endpoint_id: victim.id(),
        addrs: vec![TransportAddr::Relay(config.relay_url.clone())],
    };

    // Within the backlog: every dial handshakes and queues, no
    // acceptor anywhere.
    let mut held = Vec::new();
    for i in 0..ACCEPT_BACKLOG {
        let conn = prober
            .connect(victim_addr(), ALPN.to_vec())
            .await
            .map_err(|e| format!("dial {i} within the backlog: {e:?}"))?;
        held.push(conn);
    }

    // Past the backlog: refused, surfaced as connect-failed.
    match prober.connect(victim_addr(), ALPN.to_vec()).await {
        Err(Error::ConnectFailed(_)) => {}
        Ok(_) => return Err("a dial past the backlog connected".into()),
        Err(other) => {
            return Err(format!(
                "expected connect-failed past the backlog, got {other:?}"
            ))
        }
    }

    // Accepting drains the backlog: one accept makes room for one
    // dial.
    let accepted = victim.accept().await.map_err(fail("accept"))?;
    let refill = prober
        .connect(victim_addr(), ALPN.to_vec())
        .await
        .map_err(fail("dial after accept"))?;

    drop(accepted);
    drop(refill);
    drop(held);
    victim.close();
    prober.close();

    Ok(RunReport {
        endpoint_id: hex::encode(prober.id()),
        peer_id: hex::encode(victim.id()),
        path: String::new(),
        handshake_ms: 0,
        roundtrip_ms: 0,
        received: "accept backlog probes passed".into(),
        datagram: None,
    })
}

/// Silence the unused-import lint for the connection alias the bindings
/// export; the demo touches it only through method calls.
#[allow(unused)]
fn _use(c: &Connection) {}

bindings::export!(Component with_types_in bindings);
