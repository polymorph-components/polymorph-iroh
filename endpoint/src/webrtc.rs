//! The WebRTC wire: data channels negotiated by signaling through the
//! relay, carrying QUIC one datagram per binary message.
//!
//! Signaling is the spike's proven convention, now a recorded ruling
//! (issue #2): one JSON signal per relay datagram, marked by a leading
//! `0x00` byte — never a valid first byte of a QUIC packet, whose fixed
//! bit is set — addressed to and filtered by the relay-authenticated
//! peer. Stock relays forward it like any other datagram. One signaling
//! session per peer at a time (a v0 latitude); an offer arriving for a
//! peer with an active session is dropped.
//!
//! The dialer waits for its channel to reach `open` — not merely
//! ICE-connected — before QUIC dials, so the first flight is not lost
//! to the answerer's still-forming channel (issue #8).

use std::rc::Rc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::bindings::polymorph::iroh::types::Error;
use crate::bindings::polymorph::webrtc_datachannels::connections::{
    DataChannel, DataChannelOptions, PeerConnection,
};
use crate::bindings::polymorph::webrtc_datachannels::types::{
    DataChannelState, IceCandidate, Message as ChannelMessage, SdpType, SessionDescription,
};
use crate::endpoint_impl::{wait_until, Shared};

/// The first byte of every signaling datagram on the relay.
pub const SIGNAL_PREFIX: u8 = 0x00;

/// Bound on one signaling dance; a silent peer fails `connect-failed`
/// rather than hanging (mirrors noq's default idle timeout).
const SIGNAL_DEADLINE: Duration = Duration::from_secs(30);

/// One negotiated channel and the peer connection that owns it. The
/// channel dies with the peer connection, so both live here.
pub struct ChannelWire {
    peer_conn: PeerConnection,
    channel: DataChannel,
}

impl ChannelWire {
    /// The next inbound QUIC datagram; text messages are skipped.
    /// `Err` when the channel closes.
    pub async fn receive(&self) -> Result<Option<Vec<u8>>, String> {
        match self.channel.receive().await {
            Ok(ChannelMessage::Binary(datagram)) => Ok(Some(datagram)),
            Ok(ChannelMessage::String(_)) => Ok(None),
            Err(err) => Err(format!("data channel: {err:?}")),
        }
    }

    /// Send one QUIC datagram as one binary message.
    pub async fn send(&self, payload: &[u8]) -> Result<(), String> {
        self.channel
            .send(ChannelMessage::Binary(payload.to_vec()))
            .await
            .map_err(|err| format!("data channel: {err:?}"))
    }

    /// Initiate the wire's close (sync, idempotent); a pending `receive`
    /// then resolves with its closed error.
    pub fn close(&self) {
        self.channel.close();
        self.peer_conn.close();
    }
}

/// The signaling schema: the sibling demo's offer/answer/candidate JSON
/// plus a `done` sentinel ending each side's signals. Identities travel
/// in no signal — the relay authenticates each datagram's source.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Signal {
    Offer {
        sdp: String,
    },
    Answer {
        sdp: String,
    },
    Candidate {
        candidate: String,
        #[serde(default)]
        sdp_mid: Option<String>,
        #[serde(default)]
        sdp_mline_index: Option<u16>,
    },
    EndOfCandidates,
    Done,
}

/// The channel configuration QUIC needs from the wire: a datagram
/// carrier. Unordered, zero retransmissions — losses and reordering are
/// QUIC's to handle (the issue #1 profile, with the fixed 1200-byte MTU
/// ruled at `transport_config`).
fn quic_channel_options() -> DataChannelOptions {
    let options = DataChannelOptions::new();
    options.set_label("quic");
    options.set_ordered(false);
    options.set_max_retransmits(Some(0));
    options
}

/// Ends the session slot for `peer` when the dance ends, however it
/// ends (guards the one-session-per-peer invariant against `?` exits).
struct SessionGuard {
    shared: Shared,
    peer: [u8; 32],
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.shared.borrow_mut().end_signaling(self.peer);
    }
}

/// Publish one signal to `peer` through the relay outbox, addressed via
/// the session's relay.
fn publish(shared: &Shared, peer: [u8; 32], signal: &Signal) -> Result<(), Error> {
    let mut payload = vec![SIGNAL_PREFIX];
    serde_json::to_writer(&mut payload, signal)
        .map_err(|e| Error::Other(format!("encode signal: {e}")))?;
    let mut st = shared.borrow_mut();
    let relay = st
        .signaling_relay(peer)
        .ok_or(Error::Other("signal outside a session".into()))?;
    st.push_signal_outbound(relay, peer, payload);
    Ok(())
}

/// The peer's next signal, from the inbox the pump fills (arrivals wake
/// the parked waiter; the deadline is observed at the pump's tick).
/// `Ok(None)` once the peer sends `done`; errors on the deadline or
/// endpoint close.
async fn next_signal(
    shared: &Shared,
    peer: [u8; 32],
    started: Instant,
) -> Result<Option<Signal>, Error> {
    loop {
        let payload = wait_until(shared, move |st| {
            if st.is_closed_or_dead() {
                return Some(Err(Error::Closed));
            }
            if let Some(payload) = st.pop_signal_inbox(peer) {
                return Some(Ok(payload));
            }
            if started.elapsed() > SIGNAL_DEADLINE {
                return Some(Err(Error::ConnectFailed(
                    "webrtc signaling timed out".into(),
                )));
            }
            None
        })
        .await?;
        let signal: Signal = match serde_json::from_slice(&payload) {
            Ok(signal) => signal,
            // A malformed signal is the peer's bug; skip it.
            Err(_) => continue,
        };
        match signal {
            Signal::Done => return Ok(None),
            other => return Ok(Some(other)),
        }
    }
}

/// Drain local ICE candidates to the peer, then end-of-candidates. The
/// candidate stream ends at gathering-complete, which the host bounds.
async fn publish_candidates(
    shared: &Shared,
    peer: [u8; 32],
    conn: &PeerConnection,
) -> Result<(), Error> {
    let mut stream = conn.local_ice_candidates();
    let mut candidates = Vec::new();
    loop {
        let (status, batch) = stream.read(Vec::with_capacity(4)).await;
        candidates.extend(batch);
        if matches!(
            status,
            wit_bindgen::StreamResult::Dropped | wit_bindgen::StreamResult::Cancelled
        ) {
            break;
        }
    }
    for candidate in candidates {
        publish(
            shared,
            peer,
            &Signal::Candidate {
                candidate: candidate.candidate,
                sdp_mid: candidate.sdp_mid,
                sdp_mline_index: candidate.sdp_mline_index,
            },
        )?;
    }
    publish(shared, peer, &Signal::EndOfCandidates)
}

/// Consume the peer's signals to its `done`, applying an answer and each
/// trickled candidate.
async fn consume_signaling(
    shared: &Shared,
    peer: [u8; 32],
    conn: &PeerConnection,
    started: Instant,
) -> Result<(), Error> {
    while let Some(signal) = next_signal(shared, peer, started).await? {
        match signal {
            Signal::Answer { sdp } => conn
                .set_remote_description(SessionDescription {
                    kind: SdpType::Answer,
                    sdp,
                })
                .await
                .map_err(rtc)?,
            Signal::Offer { .. } => {
                return Err(Error::ConnectFailed("unexpected second offer".into()));
            }
            Signal::Candidate {
                candidate,
                sdp_mid,
                sdp_mline_index,
            } => conn
                .add_ice_candidate(IceCandidate {
                    candidate,
                    sdp_mid,
                    sdp_mline_index,
                })
                .await
                .map_err(rtc)?,
            Signal::EndOfCandidates => {}
            Signal::Done => unreachable!("next_signal maps done to none"),
        }
    }
    Ok(())
}

/// Background upgrade: the offerer dance for `peer` through pool relay
/// `via`, moving the peer's route onto the channel on success. Spawned
/// by the pump for each relay-dialed connection that carried a `webrtc`
/// hint. Failure is silent: the connection stays on the relay, and the
/// caller observes the path through `connection.path`.
pub async fn upgrade(shared: Shared, peer: [u8; 32], via: u32) {
    let Ok(wire) = dial(&shared, peer, via).await else {
        return;
    };
    let _ = shared.borrow_mut().register_channel(peer, wire);
}

/// Dial `peer` over WebRTC: the offerer's dance, resolving once the
/// channel is `open` and QUIC may flow.
async fn dial(shared: &Shared, peer: [u8; 32], via: u32) -> Result<Rc<ChannelWire>, Error> {
    shared.borrow_mut().begin_signaling(peer, via)?;
    let _guard = SessionGuard {
        shared: shared.clone(),
        peer,
    };
    let started = Instant::now();

    let conn = PeerConnection::new(None);
    let channel = conn
        .create_data_channel(quic_channel_options())
        .map_err(rtc)?;
    // Take the once-only state stream before anything can transition.
    let mut states = channel.state_changes();

    let offer = conn.create_offer().await.map_err(rtc)?;
    let offer_sdp = offer.sdp.clone();
    conn.set_local_description(offer).await.map_err(rtc)?;
    publish(shared, peer, &Signal::Offer { sdp: offer_sdp })?;
    publish_candidates(shared, peer, &conn).await?;
    publish(shared, peer, &Signal::Done)?;

    consume_signaling(shared, peer, &conn, started).await?;

    conn.wait_connected().await.map_err(rtc)?;

    // The first flight must not race the answerer's channel: wait for
    // `open`, not ICE-connected (issue #8).
    loop {
        let (status, batch) = states.read(Vec::with_capacity(1)).await;
        if batch.contains(&DataChannelState::Open) {
            break;
        }
        if batch.contains(&DataChannelState::Closed)
            || matches!(
                status,
                wit_bindgen::StreamResult::Dropped | wit_bindgen::StreamResult::Cancelled
            )
        {
            return Err(Error::ConnectFailed(
                "webrtc channel closed before opening".into(),
            ));
        }
        if started.elapsed() > SIGNAL_DEADLINE {
            return Err(Error::ConnectFailed("webrtc channel open timed out".into()));
        }
    }

    Ok(Rc::new(ChannelWire {
        peer_conn: conn,
        channel,
    }))
}

/// Answer `peer`'s offer: the answerer's dance, spawned by the pump on
/// the first signal from a peer without a session. On success the
/// channel registers and the peer's route moves onto it; inbound QUIC
/// then flows through the pump under the peer's standin address.
pub async fn answer(shared: Shared, peer: [u8; 32]) {
    let _guard = SessionGuard {
        shared: shared.clone(),
        peer,
    };
    // Failures end the session silently: the dialer times out and
    // reports; an answerer has nobody to report to.
    let _ = answer_inner(&shared, peer).await;
}

async fn answer_inner(shared: &Shared, peer: [u8; 32]) -> Result<(), Error> {
    let started = Instant::now();

    let conn = PeerConnection::new(None);

    let offer = match next_signal(shared, peer, started).await? {
        Some(Signal::Offer { sdp }) => sdp,
        _ => return Err(Error::Other("expected an offer".into())),
    };
    conn.set_remote_description(SessionDescription {
        kind: SdpType::Offer,
        sdp: offer,
    })
    .await
    .map_err(rtc)?;

    let answer = conn.create_answer().await.map_err(rtc)?;
    let answer_sdp = answer.sdp.clone();
    conn.set_local_description(answer).await.map_err(rtc)?;
    publish(shared, peer, &Signal::Answer { sdp: answer_sdp })?;
    publish_candidates(shared, peer, &conn).await?;
    publish(shared, peer, &Signal::Done)?;

    consume_signaling(shared, peer, &conn, started).await?;

    conn.wait_connected().await.map_err(rtc)?;

    let mut incoming = conn.incoming_data_channels();
    let (_status, batch) = incoming.read(Vec::with_capacity(1)).await;
    let channel = batch
        .into_iter()
        .next()
        .ok_or(Error::Other("no incoming data channel".into()))?;

    let wire = Rc::new(ChannelWire {
        peer_conn: conn,
        channel,
    });
    shared.borrow_mut().register_channel(peer, wire)?;
    Ok(())
}

fn rtc(err: crate::bindings::polymorph::webrtc_datachannels::types::Error) -> Error {
    Error::ConnectFailed(format!("webrtc: {err:?}"))
}
