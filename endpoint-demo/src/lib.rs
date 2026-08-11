//! The endpoint demo: a plain consumer of `polymorph:iroh/endpoint`, composed
//! with the endpoint component via `wac plug`. It exercises the surface
//! exactly the way an application protocol would: bind, connect or accept
//! by endpoint ID, one bidirectional stream, one echo each way.

use std::io::Write;
use std::time::Instant;

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
use bindings::polymorph::iroh::endpoint::{Connection, Endpoint, EndpointOptions};
use bindings::polymorph::iroh::identity_from_keys::from_keys;
use bindings::polymorph::iroh::identity_generate::generate;
use bindings::polymorph::iroh::types::{EndpointAddr, Error, PathKind, TransportAddr};
use bindings::wasi::clocks::monotonic_clock;
use polymorph_webcrypto_guest::{ecdsa, ed25519, SigningKeyOptions};

/// The demo's ALPN protocol.
const ALPN: &[u8] = b"iroh-demo/0";

/// Cap on one read call; the demo's payloads are tiny.
const READ_MAX: u32 = 16 * 1024;

/// Copies of the demo datagram sent (client) and of its echo (server):
/// datagrams are lossy by contract, and duplication makes the exchange
/// robust without either side cancelling a pending receive (an
/// in-flight import subtask must resolve — the jco discipline).
const DATAGRAM_COPIES: usize = 3;

/// Polling quantum and bound while waiting for the WebRTC upgrade.
const UPGRADE_POLL_NS: u64 = 5_000_000;
const UPGRADE_DEADLINE_POLLS: u32 = 30_000 / 5;

struct Component;

impl Guest for Component {
    async fn run(config: RunConfig) -> Result<RunReport, String> {
        if config.identity_negative {
            return run_identity_negative().await;
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
    // the wire it asked for, so wait for the flip before sending.
    if config.webrtc {
        let mut polls = 0;
        while conn.path() != PathKind::Webrtc {
            polls += 1;
            if polls > UPGRADE_DEADLINE_POLLS {
                return Err("webrtc upgrade did not complete".into());
            }
            monotonic_clock::wait_for(UPGRADE_POLL_NS).await;
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
        Some(run_client_datagram(&conn, &config.message).await?)
    } else {
        None
    };
    let path = path_name(conn.path());

    conn.close(0, "done");
    conn.wait_closed().await;

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
async fn run_client_datagram(conn: &Connection, message: &str) -> Result<String, String> {
    let max = conn
        .max_datagram_size()
        .ok_or("peer does not accept datagrams")?;
    let payload = format!("datagram {message}").into_bytes();
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
    Ok(String::from_utf8_lossy(&echoed).into_owned())
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
    // verbatim in copies of our own.
    let datagram = if config.datagram {
        let payload = conn.recv_datagram().await.map_err(fail("recv-datagram"))?;
        for _ in 0..DATAGRAM_COPIES {
            conn.send_datagram(&payload)
                .map_err(fail("send-datagram"))?;
        }
        Some(String::from_utf8_lossy(&payload).into_owned())
    } else {
        None
    };
    let path = path_name(conn.path());

    // The client closes once it has its echo; that close is the demo's
    // natural end on this side.
    conn.wait_closed().await;

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

fn fail(what: &'static str) -> impl Fn(Error) -> String {
    move |err| format!("{what}: {err:?}")
}

/// Silence the unused-import lint for the connection alias the bindings
/// export; the demo touches it only through method calls.
#[allow(unused)]
fn _use(c: &Connection) {}

bindings::export!(Component with_types_in bindings);
