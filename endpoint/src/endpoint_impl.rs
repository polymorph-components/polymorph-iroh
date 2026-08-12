//! The endpoint surface implementation: noq-proto state shared between
//! the exported resources and one detached pump task per bound endpoint.
//!
//! Wake-ups are event-driven in both directions. Resource methods
//! mutate the shared state directly, kick the pump to flush the
//! consequences (`State::kick_pump`), and park on a waker in
//! `State::waiters`; the pump wakes the waiters after every drain that
//! progressed (`State::wake_waiters`). Cross-task wakeups ride
//! wit-bindgen's `inter-task-wakeup` channel — a guest-internal unit
//! stream whose write resumes a task parked in `waitable-set.wait` —
//! which both hosts deliver. (The jco-era bounded-polling pump this
//! replaces is recorded on issues #10 and #42.)
//!
//! The pump's clock tick stays: noq's timers need servicing, and the
//! tick turn wakes all waiters unconditionally, which bounds two things
//! at one tick — how late a waiter's deadline condition (relay-open
//! timeout, signaling deadline) is observed, and how stale a missed
//! wake edge can go.
//!
//! An in-flight import is a component-model subtask and is always
//! awaited to completion, never dropped mid-flight (the teardown
//! discipline; the kick future is guest-local, so re-creating it each
//! select turn cancels nothing). All of it runs on the component-model
//! async ABI's single cooperative thread: the `RefCell` borrows never
//! cross an await, and a fired waker resumes its task through the
//! scheduler, never synchronously.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::pin::pin;
use std::rc::Rc;
use std::sync::Arc;
use std::task::{Poll, Waker};

use std::time::{Duration, Instant};

use bytes::BytesMut;
use futures::future::FusedFuture;
use futures::stream::FuturesUnordered;
use futures::{select_biased, FutureExt, StreamExt};
use noq_proto::{
    ClientConfig, Connection as NoqConnection, ConnectionError, ConnectionHandle, DatagramEvent,
    Dir, Endpoint as NoqEndpoint, EndpointConfig, Event, FinishError, FourTuple,
    MtuDiscoveryConfig, PathId, ReadError, ReadableError, ServerConfig, StreamEvent, StreamId,
    TransportConfig, VarInt, WriteError,
};

use iroh_endpoint_core::crypto::sign::Identity;
use iroh_endpoint_core::tls;
use polymorph_tls_quic::{HandshakeData, QuicClientConfig, QuicServerConfig, ResetKey, TokenKey};

use crate::bindings::exports::polymorph::iroh::endpoint::{
    Connection, Endpoint, EndpointOptions, Guest, GuestConnection, GuestEndpoint,
    GuestEndpointOptions, GuestRecvStream, GuestSendStream, IdentityBorrow, RecvStream, SendStream,
};
use crate::bindings::polymorph::iroh::types::{
    CloseInfo, ConnectionState, EndpointAddr, Error, PathKind, TransportAddr,
};
use crate::bindings::wasi::clocks::monotonic_clock;
use crate::bindings::{wit_future, wit_stream};
use crate::identity::IdentityRes;
use crate::udp::UdpWire;
use crate::webrtc::{self, ChannelWire, SIGNAL_PREFIX};
use crate::Component;
use iroh_endpoint_core::relay::RelayConn;
use wit_bindgen::rt::async_support::{FutureReader, StreamReader};

/// The pump's tick: noq's deadlines, the waiters' deadline re-check
/// cadence, and the bound on how stale a missed wake edge can go.
const TICK_NS: u64 = 10_000_000;

/// Bounded window for final packets after `endpoint.close`.
const LINGER: Duration = Duration::from_millis(500);

/// The bound on connections handshaking or handshaken toward `accept`
/// that no acceptor has claimed. At the bound, new incoming attempts
/// are refused — the dialer sees the refusal as `connect-failed` — so
/// an endpoint that is slow to accept (or never accepts) holds bounded
/// state no matter how many peers can reach it (issue #13, finding
/// B7). Accepting drains the backlog; refused peers may retry.
const ACCEPT_BACKLOG: usize = 16;

/// The packet-size ceiling every path's MTU discovery searches up to,
/// and the largest UDP payload this endpoint advertises accepting
/// (issue #47, amending issue #1's fixed-1200 ruling). Sized by
/// measurement, not by the wires' hard caps (the stock relay takes
/// 64 KiB packets, data-channel implementations commonly 64 KiB
/// messages): bulk throughput improves on every wire at 4096 but the
/// channel wire collapses when full packets span many SCTP chunks —
/// 8192 (~7 chunks per message) measured 3x WORSE than the fixed-1200
/// profile on the webrtc bulk row, while 4096 (~3.4 chunks) beats it.
/// The bench's budget rows are the regression guard. For datagram
/// consumers the ceiling erases the fragmentation tax: ~4 KiB
/// application datagrams, against the ~1.4 KiB frames protocols like
/// mosh need.
const MTU_CEILING: u16 = 4096;

/// The transport profile shared by every wire: a 1200-byte floor with
/// per-path MTU discovery bounded by `MTU_CEILING`. Discovery is what
/// differentiates the wires — no per-path configuration exists in noq.
/// Probes on the relay and data-channel wires always arrive (both
/// carry far larger messages natively), so those paths converge on the
/// ceiling; probes on a real UDP path die above the true path MTU, so
/// the direct path finds reality (and the peer's `max-udp-payload-size`
/// advertisement — 1472 from upstream iroh — caps the search). noq's
/// per-path black-hole detector shrinks a path whose large packets
/// start dying: the guard for a lossy channel fragmenting them. GSO
/// batching stays disabled — one datagram per transmit.
fn transport_config() -> Arc<TransportConfig> {
    let mut config = TransportConfig::default();
    config.initial_mtu(1200);
    let mut mtud = MtuDiscoveryConfig::default();
    mtud.upper_bound(MTU_CEILING);
    config.mtu_discovery_config(Some(mtud));
    Arc::new(config)
}

/// An application code (close, reset, stop) as QUIC's variable-length
/// integer. QUIC carries at most 2^62 - 1; larger values saturate, as
/// the WIT documents.
fn app_code(code: u64) -> VarInt {
    VarInt::from_u64(code).unwrap_or(VarInt::MAX)
}

pub(crate) type Shared = Rc<RefCell<State>>;

pub(crate) struct State {
    noq: NoqEndpoint,
    conns: HashMap<ConnectionHandle, ConnEntry>,
    peer_to_addr: HashMap<[u8; 32], SocketAddr>,
    addr_to_peer: HashMap<SocketAddr, [u8; 32]>,
    next_host: u32,
    accept_queue: VecDeque<ConnectionHandle>,
    relay_outbound: VecDeque<(u32, [u8; 32], Vec<u8>)>,
    udp_outbound: VecDeque<(SocketAddr, Vec<u8>)>,
    /// Transmits bound for WebRTC channels, keyed by channel id.
    channel_outbound: VecDeque<(u32, Vec<u8>)>,
    /// The wire currently carrying each synthetic peer address.
    /// Transmits to an address with no entry go to the UDP socket
    /// (real addresses are never in this map).
    routes: HashMap<SocketAddr, RouteWire>,
    /// The relay pool: the home relay (key `HOME_RELAY`) plus foreign
    /// relays opened for dialing or signaling, keyed by their
    /// normalized URL in `relay_keys`. A dead foreign relay leaves the
    /// pool; routes naming it drop transmits until their connections
    /// idle out.
    relay_pool: HashMap<u32, Rc<RelayConn>>,
    relay_keys: HashMap<String, u32>,
    /// URLs an in-flight `connect` is currently opening; a second
    /// dialer waits for the first instead of opening twice.
    relay_opening: HashSet<String>,
    /// Relays registered since the pump last armed receives.
    new_relays: Vec<(u32, Rc<RelayConn>)>,
    next_relay_key: u32,
    /// Peers whose relay-dialed connections asked for a WebRTC
    /// upgrade, with the relay to signal through; the pump spawns one
    /// offerer session per entry.
    pending_upgrades: Vec<([u8; 32], u32)>,
    /// Whether this endpoint dials `webrtc` entries and answers
    /// inbound signaling (`endpoint-options.webrtc`).
    webrtc_enabled: bool,
    /// Peers with an active signaling session (offerer or answerer),
    /// mapped to the relay the session signals through; one session
    /// per peer at a time.
    signaling: HashMap<[u8; 32], u32>,
    /// Inbound signaling payloads (the JSON after the prefix byte),
    /// keyed by the relay-authenticated source. Sessions poll these.
    signal_inboxes: HashMap<[u8; 32], VecDeque<Vec<u8>>>,
    /// Open channels by id: route targets, not noq addresses.
    channels: HashMap<u32, ChannelEntry>,
    /// Channels registered since the pump last armed receives.
    new_channels: Vec<(u32, Rc<ChannelWire>)>,
    next_channel_id: u32,
    closed: bool,
    closed_at: Option<Instant>,
    /// Set when the relay connection died; every operation fails from
    /// then on.
    dead: Option<String>,
    /// Wakers parked by `wait_until` futures, drained and fired by
    /// `wake_waiters`.
    waiters: Vec<Waker>,
    /// The pump's parked waker and the pending-kick flag behind
    /// `kick_pump` (consumed by the pump's `kicked` select arm).
    pump_waker: Option<Waker>,
    pump_kicked: bool,
}

/// The wire behind one synthetic peer address.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RouteWire {
    /// A relay from the pool, by key.
    Relay(u32),
    Channel(u32),
}

/// The home relay's pool key; its death kills the endpoint, where a
/// foreign relay's death only starves the routes that named it.
const HOME_RELAY: u32 = 0;

struct ChannelEntry {
    wire: Rc<ChannelWire>,
    /// The relay-authenticated peer the channel was signaled with;
    /// connections accepted over it must authenticate as this identity.
    peer: [u8; 32],
    /// The relay the channel was signaled through — where the peer is
    /// provably reachable, and where its route returns if the channel
    /// dies.
    fallback_relay: u32,
}

struct ConnEntry {
    conn: NoqConnection,
    /// The identity this connection must authenticate as, when one is
    /// known up front: the dialed identity on the client side, the
    /// relay-authenticated datagram source on relay-accepted connections.
    /// `None` on direct-path accepted connections, whose identity has no
    /// out-of-band claim — the TLS-authenticated key is adopted instead.
    expected_peer: Option<[u8; 32]>,
    /// The authenticated peer identity, set at `Connected`.
    peer: Option<[u8; 32]>,
    accepted_side: bool,
    connected: bool,
    alpn: Vec<u8>,
    error: Option<Error>,
    /// The peer's application close, captured at `ConnectionLost`.
    /// `None` when the connection ends any other way: closed locally,
    /// idle-timed-out, or lost to a transport error.
    peer_close: Option<CloseInfo>,
    drained: bool,
    bi_queue: VecDeque<StreamId>,
    uni_queue: VecDeque<StreamId>,
}

impl ConnEntry {
    fn new(conn: NoqConnection, expected_peer: Option<[u8; 32]>, accepted_side: bool) -> Self {
        Self {
            conn,
            expected_peer,
            peer: None,
            accepted_side,
            connected: false,
            alpn: Vec::new(),
            error: None,
            peer_close: None,
            drained: false,
            bi_queue: VecDeque::new(),
            uni_queue: VecDeque::new(),
        }
    }
}

impl State {
    fn new(noq: NoqEndpoint, webrtc_enabled: bool) -> Self {
        Self {
            noq,
            conns: HashMap::new(),
            peer_to_addr: HashMap::new(),
            addr_to_peer: HashMap::new(),
            next_host: 0,
            accept_queue: VecDeque::new(),
            relay_outbound: VecDeque::new(),
            udp_outbound: VecDeque::new(),
            channel_outbound: VecDeque::new(),
            routes: HashMap::new(),
            relay_pool: HashMap::new(),
            relay_keys: HashMap::new(),
            relay_opening: HashSet::new(),
            new_relays: Vec::new(),
            next_relay_key: 0,
            pending_upgrades: Vec::new(),
            webrtc_enabled,
            signaling: HashMap::new(),
            signal_inboxes: HashMap::new(),
            channels: HashMap::new(),
            new_channels: Vec::new(),
            next_channel_id: 0,
            closed: false,
            closed_at: None,
            dead: None,
            waiters: Vec::new(),
            pump_waker: None,
            pump_kicked: false,
        }
    }

    /// The stable synthetic socket address standing in for `peer` (the
    /// relay and channel wires have no addresses; noq wants one
    /// distinct, stable address per peer, whichever wire carries the
    /// packets). Drawn from `2001:db8:77::/48` — the IPv6 documentation
    /// prefix is never routable, so no real peer address can collide
    /// with a standin. A fresh standin routes to the relay it was
    /// first seen through (`via`) until a channel upgrade moves it.
    fn addr_for_peer(&mut self, peer: [u8; 32], via: u32) -> SocketAddr {
        if let Some(addr) = self.peer_to_addr.get(&peer) {
            return *addr;
        }
        self.next_host += 1;
        let addr = doc_prefix_addr(0x77, self.next_host);
        self.peer_to_addr.insert(peer, addr);
        self.addr_to_peer.insert(addr, peer);
        self.routes.insert(addr, RouteWire::Relay(via));
        addr
    }

    /// Add a relay connection to the pool under its normalized URL.
    /// The first registration is the home relay (`HOME_RELAY`). Kicks
    /// the pump to arm the relay's receive.
    fn register_relay(&mut self, url: &str, conn: Rc<RelayConn>) -> u32 {
        let key = self.next_relay_key;
        self.next_relay_key += 1;
        self.relay_pool.insert(key, conn.clone());
        self.relay_keys.insert(normalize_relay_url(url), key);
        self.new_relays.push((key, conn));
        self.kick_pump();
        key
    }

    /// Wake every parked `wait_until` future to re-check its condition.
    /// A woken task resumes through the scheduler, never synchronously,
    /// so calling this under the `RefCell` borrow is sound.
    pub(crate) fn wake_waiters(&mut self) {
        for waker in self.waiters.drain(..) {
            waker.wake();
        }
    }

    /// Wake the pump to flush the consequences of a state mutation:
    /// queued transmits and signals, new relays and channels, pending
    /// upgrades, close.
    pub(crate) fn kick_pump(&mut self) {
        self.pump_kicked = true;
        if let Some(waker) = self.pump_waker.take() {
            waker.wake();
        }
    }

    /// True once no operation can succeed anymore; signaling sessions
    /// poll this to abandon their dance.
    pub(crate) fn is_closed_or_dead(&self) -> bool {
        self.closed || self.dead.is_some()
    }

    /// Claim the signaling slot for `peer`, recording the relay the
    /// session signals through; one session at a time.
    pub(crate) fn begin_signaling(&mut self, peer: [u8; 32], relay: u32) -> Result<(), Error> {
        if self.signaling.contains_key(&peer) {
            return Err(Error::ConnectFailed(
                "a webrtc signaling session with this peer is already active".into(),
            ));
        }
        self.signaling.insert(peer, relay);
        Ok(())
    }

    /// Release `peer`'s signaling slot and drop its unread signals.
    pub(crate) fn end_signaling(&mut self, peer: [u8; 32]) {
        self.signaling.remove(&peer);
        self.signal_inboxes.remove(&peer);
    }

    /// The relay `peer`'s active signaling session speaks through.
    pub(crate) fn signaling_relay(&self, peer: [u8; 32]) -> Option<u32> {
        self.signaling.get(&peer).copied()
    }

    /// Queue one signaling payload for the pump to relay to `peer`
    /// through the session's relay, kicking the pump to flush it.
    pub(crate) fn push_signal_outbound(&mut self, relay: u32, peer: [u8; 32], payload: Vec<u8>) {
        self.relay_outbound.push_back((relay, peer, payload));
        self.kick_pump();
    }

    /// The next signaling payload from `peer`, if any.
    pub(crate) fn pop_signal_inbox(&mut self, peer: [u8; 32]) -> Option<Vec<u8>> {
        self.signal_inboxes.get_mut(&peer)?.pop_front()
    }

    /// Register an open channel to `peer` and move the peer's route
    /// onto it: noq keeps addressing the peer's standin while the
    /// packets change wire. Kicks the pump to arm the channel's
    /// receive. A closing endpoint refuses and closes the wire.
    pub(crate) fn register_channel(
        &mut self,
        peer: [u8; 32],
        wire: Rc<ChannelWire>,
    ) -> Result<(), Error> {
        if self.is_closed_or_dead() {
            wire.close();
            return Err(Error::Closed);
        }
        let fallback_relay = self.signaling_relay(peer).unwrap_or(HOME_RELAY);
        self.next_channel_id += 1;
        let id = self.next_channel_id;
        self.channels.insert(
            id,
            ChannelEntry {
                wire: wire.clone(),
                peer,
                fallback_relay,
            },
        );
        self.new_channels.push((id, wire));
        let synthetic = self.addr_for_peer(peer, fallback_relay);
        self.routes.insert(synthetic, RouteWire::Channel(id));
        self.kick_pump();
        Ok(())
    }

    /// Retire a dead channel; a peer routed over it moves back to the
    /// relay it was signaled through (its connections survive the move
    /// or idle out).
    fn retire_channel(&mut self, id: u32) {
        let Some(entry) = self.channels.remove(&id) else {
            return;
        };
        if let Some(synthetic) = self.peer_to_addr.get(&entry.peer) {
            if self.routes.get(synthetic) == Some(&RouteWire::Channel(id)) {
                self.routes
                    .insert(*synthetic, RouteWire::Relay(entry.fallback_relay));
            }
        }
    }

    fn mark_dead(&mut self, reason: &str) {
        self.dead = Some(reason.to_string());
        for entry in self.conns.values_mut() {
            if entry.error.is_none() {
                entry.error = Some(Error::Closed);
            }
        }
    }

    /// Drain endpoint-bound events, application events, and transmits
    /// until quiescent; returns whether anything progressed, so the
    /// pump wakes parked method futures exactly when the state they
    /// observe may have changed.
    fn drain(&mut self) -> bool {
        let mut any_progress = false;
        let now = Instant::now();
        let State {
            noq,
            conns,
            addr_to_peer,
            accept_queue,
            relay_outbound,
            udp_outbound,
            channel_outbound,
            routes,
            ..
        } = self;
        for (handle, entry) in conns.iter_mut() {
            let mut buf = Vec::with_capacity(MTU_CEILING as usize);
            loop {
                let mut progressed = false;

                while let Some(event) = entry.conn.poll_endpoint_events() {
                    progressed = true;
                    if let Some(back) = noq.handle_event(*handle, event) {
                        entry.conn.handle_event(back);
                    }
                }

                while let Some(event) = entry.conn.poll() {
                    progressed = true;
                    on_event(entry, *handle, event, accept_queue);
                }

                loop {
                    buf.clear();
                    match entry
                        .conn
                        .poll_transmit(now, std::num::NonZeroUsize::MIN, &mut buf)
                    {
                        Some(transmit) => {
                            progressed = true;
                            let datagram = buf[..transmit.size].to_vec();
                            // Route by the standin's current wire; real
                            // addresses have no route entry and go to
                            // the UDP socket.
                            match routes.get(&transmit.destination) {
                                Some(RouteWire::Relay(key)) => {
                                    let peer = addr_to_peer[&transmit.destination];
                                    relay_outbound.push_back((*key, peer, datagram));
                                }
                                Some(RouteWire::Channel(id)) => {
                                    channel_outbound.push_back((*id, datagram));
                                }
                                None => {
                                    udp_outbound.push_back((transmit.destination, datagram));
                                }
                            }
                        }
                        None => break,
                    }
                }

                if !progressed {
                    break;
                }
                any_progress = true;
            }
            if !entry.drained && entry.conn.is_drained() {
                entry.drained = true;
                any_progress = true;
            }
        }
        any_progress
    }

    fn handle_relay_datagram(&mut self, via: u32, source: [u8; 32], payload: Vec<u8>) {
        let addr = self.addr_for_peer(source, via);
        self.handle_datagram(addr, Some(source), payload);
    }

    fn handle_udp_datagram(&mut self, remote: SocketAddr, payload: Vec<u8>) {
        self.handle_datagram(remote, None, payload);
    }

    /// A datagram from a channel enters noq under the peer's standin
    /// — the same address the relay wire uses, so an upgraded
    /// connection sees one unbroken path — attributed to the
    /// signaling-authenticated peer.
    fn handle_channel_datagram(&mut self, id: u32, payload: Vec<u8>) {
        let Some((peer, via)) = self
            .channels
            .get(&id)
            .map(|entry| (entry.peer, entry.fallback_relay))
        else {
            return;
        };
        let synthetic = self.addr_for_peer(peer, via);
        self.handle_datagram(synthetic, Some(peer), payload);
    }

    fn handle_datagram(&mut self, addr: SocketAddr, source: Option<[u8; 32]>, payload: Vec<u8>) {
        let now = Instant::now();
        let mut buf = Vec::new();
        match self.noq.handle(
            now,
            FourTuple::new(addr, None),
            None,
            BytesMut::from(&payload[..]),
            &mut buf,
        ) {
            Some(DatagramEvent::ConnectionEvent(handle, event)) => {
                if let Some(entry) = self.conns.get_mut(&handle) {
                    entry.conn.handle_event(event);
                }
            }
            Some(DatagramEvent::NewConnection(incoming)) => {
                if self.closed {
                    return;
                }
                // Backpressure on accept (issue #13, finding B7): past
                // the backlog of un-accepted connections, new attempts
                // are refused — the dialer sees the refusal — instead
                // of handshaking and queueing without bound.
                if self.accept_backlog() >= ACCEPT_BACKLOG {
                    buf.clear();
                    let transmit = self.noq.refuse(incoming, &mut buf);
                    self.push_response(addr, source, &buf[..transmit.size]);
                    return;
                }
                buf.clear();
                match self.noq.accept(incoming, now, &mut buf, None) {
                    Ok((handle, conn)) => {
                        self.conns
                            .insert(handle, ConnEntry::new(conn, source, true));
                    }
                    Err(err) => {
                        if let Some(transmit) = err.response {
                            self.push_response(addr, source, &buf[..transmit.size]);
                        }
                    }
                }
            }
            Some(DatagramEvent::Response(transmit)) => {
                self.push_response(addr, source, &buf[..transmit.size]);
            }
            None => {}
        }
    }

    /// Send an endpoint-level response (version negotiation, retry,
    /// close) back where the datagram came from, by the standin's
    /// current route — real addresses go to the UDP socket.
    fn push_response(&mut self, addr: SocketAddr, source: Option<[u8; 32]>, payload: &[u8]) {
        match (self.routes.get(&addr), source) {
            (Some(RouteWire::Relay(key)), Some(peer)) => {
                self.relay_outbound
                    .push_back((*key, peer, payload.to_vec()));
            }
            (Some(RouteWire::Channel(id)), _) => {
                self.channel_outbound.push_back((*id, payload.to_vec()));
            }
            _ => self.udp_outbound.push_back((addr, payload.to_vec())),
        }
    }

    /// Connections handshaking or handshaken toward `accept` that no
    /// acceptor has claimed.
    fn accept_backlog(&self) -> usize {
        self.accept_queue.len()
            + self
                .conns
                .values()
                .filter(|e| e.accepted_side && !e.connected && e.error.is_none() && !e.drained)
                .count()
    }

    fn handle_timeouts(&mut self) {
        let now = Instant::now();
        for entry in self.conns.values_mut() {
            if entry
                .conn
                .poll_timeout()
                .is_some_and(|deadline| deadline <= now)
            {
                entry.conn.handle_timeout(now);
            }
        }
    }

    fn close_all(&mut self, reason: &'static [u8]) {
        let now = Instant::now();
        for entry in self.conns.values_mut() {
            if entry.error.is_none() && !entry.drained {
                entry
                    .conn
                    .close(now, VarInt::from_u32(0), bytes::Bytes::from_static(reason));
            }
        }
    }
}

fn on_event(
    entry: &mut ConnEntry,
    handle: ConnectionHandle,
    event: Event,
    accept_queue: &mut VecDeque<ConnectionHandle>,
) {
    match event {
        Event::HandshakeDataReady | Event::HandshakeConfirmed => {}
        // Single-path, no NAT traversal: nothing to act on yet.
        Event::Path(_) | Event::NatTraversal(_) => {}
        Event::Connected => {
            let session = entry.conn.crypto_session();
            if let Some(hd) = session
                .handshake_data()
                .and_then(|b| b.downcast::<HandshakeData>().ok())
            {
                entry.alpn = hd.protocol.unwrap_or_default();
            }
            let tls_peer = session
                .peer_identity()
                .and_then(|b| {
                    b.downcast::<Vec<rustls::pki_types::CertificateDer<'static>>>()
                        .ok()
                })
                .and_then(|certs| {
                    certs
                        .first()
                        .and_then(|c| tls::endpoint_id_from_spki(c.as_ref()))
                });
            match (tls_peer, entry.expected_peer) {
                (Some(id), expected) if expected.is_none() || expected == Some(id) => {
                    entry.peer = Some(id);
                    entry.connected = true;
                    if entry.accepted_side {
                        accept_queue.push_back(handle);
                    }
                }
                // The handshake authenticated a key other than the one
                // the relay authenticated as the datagram source (or the
                // one dialed): never surface the connection.
                _ => {
                    entry.error = Some(Error::ConnectFailed(
                        "authenticated key differs from the addressed peer".into(),
                    ));
                    entry.conn.close(
                        Instant::now(),
                        VarInt::from_u32(1),
                        bytes::Bytes::from_static(b"identity mismatch"),
                    );
                }
            }
        }
        Event::Stream(StreamEvent::Opened { .. }) => {
            while let Some(id) = entry.conn.streams().accept(Dir::Bi) {
                entry.bi_queue.push_back(id);
            }
            while let Some(id) = entry.conn.streams().accept(Dir::Uni) {
                entry.uni_queue.push_back(id);
            }
        }
        // Polling method futures observe readable/writable/available
        // state directly (streams and datagrams both queue inside noq);
        // the events carry nothing to record.
        Event::Stream(_) => {}
        Event::DatagramReceived | Event::DatagramsUnblocked => {}
        Event::ConnectionLost { reason } => {
            entry.error = Some(match &reason {
                ConnectionError::ApplicationClosed(close) => {
                    entry.peer_close = Some(CloseInfo {
                        code: close.error_code.into_inner(),
                        reason: String::from_utf8_lossy(&close.reason).into_owned(),
                    });
                    Error::Closed
                }
                ConnectionError::LocallyClosed => Error::Closed,
                other => Error::Other(format!("connection lost: {other}")),
            });
        }
    }
}

/// The endpoint's I/O task: relayed datagrams in and out, noq's timers,
/// and the flush after every kick. The two long-lived import futures stay
/// pinned across iterations and are resolved before the task returns (an
/// in-flight import is a component-model subtask; jco traps on cancelling
/// one — see the spike's teardown discipline). Channel receives live in a
/// persistent set with the same discipline: closing every channel
/// resolves them before the task returns.
async fn pump(shared: Shared, udp: Option<Rc<UdpWire>>) {
    let mut udp_recv = pin!(udp_receive(udp.clone()).fuse());
    let mut tick = pin!(monotonic_clock::wait_for(TICK_NS).fuse());
    let mut channel_recvs: FuturesUnordered<ChannelRecvFuture> = FuturesUnordered::new();
    let mut relay_recvs: FuturesUnordered<RelayRecvFuture> = FuturesUnordered::new();
    // Set by the tick arm: wake the waiters even without drain progress,
    // so deadline conditions are re-checked at tick granularity.
    let mut force_wake = false;

    'pump: loop {
        {
            let mut st = shared.borrow_mut();
            if st.drain() || force_wake {
                st.wake_waiters();
            }
        }
        force_wake = false;
        loop {
            let item = shared.borrow_mut().relay_outbound.pop_front();
            match item {
                Some((key, peer, datagram)) => {
                    let conn = shared.borrow().relay_pool.get(&key).cloned();
                    // A retired relay's queued transmits are lost, as is
                    // a failed foreign send; the home relay's failure is
                    // the endpoint's death.
                    if let Some(conn) = conn {
                        if conn.send_datagram(&peer, &datagram).await.is_err() && key == HOME_RELAY
                        {
                            shared.borrow_mut().mark_dead("relay send failed");
                            break 'pump;
                        }
                    }
                }
                None => break,
            }
        }
        loop {
            let item = shared.borrow_mut().udp_outbound.pop_front();
            match (item, &udp) {
                (Some((remote, datagram)), Some(wire)) => {
                    // A send failure on UDP is datagram loss, not death.
                    let _ = wire.send(remote, &datagram).await;
                }
                (Some(_), None) => {}
                (None, _) => break,
            }
        }
        loop {
            let item = shared.borrow_mut().channel_outbound.pop_front();
            match item {
                Some((id, datagram)) => {
                    let wire = shared
                        .borrow()
                        .channels
                        .get(&id)
                        .map(|entry| entry.wire.clone());
                    if let Some(wire) = wire {
                        // A send failure on a channel is datagram loss,
                        // not death (the channel's own close resolves
                        // its receive, which retires it below).
                        let _ = wire.send(&datagram).await;
                    }
                }
                None => break,
            }
        }

        // Arm receives for relays and channels registered since the
        // last turn, and spawn offerer sessions for requested upgrades.
        {
            let new_relays = std::mem::take(&mut shared.borrow_mut().new_relays);
            for (key, conn) in new_relays {
                relay_recvs.push(Box::pin(relay_receive(key, conn)));
            }
            let new_channels = std::mem::take(&mut shared.borrow_mut().new_channels);
            for (id, wire) in new_channels {
                channel_recvs.push(Box::pin(channel_receive(id, wire)));
            }
            let upgrades = std::mem::take(&mut shared.borrow_mut().pending_upgrades);
            for (peer, relay) in upgrades {
                wit_bindgen::spawn_local(webrtc::upgrade(shared.clone(), peer, relay));
            }
        }

        {
            let st = shared.borrow();
            if st.dead.is_some() {
                break 'pump;
            }
            if st.closed {
                let all_drained = st.conns.values().all(|e| e.drained || e.error.is_some());
                let lingered = st
                    .closed_at
                    .map(|at| at.elapsed() >= LINGER)
                    .unwrap_or(true);
                if all_drained || lingered {
                    break 'pump;
                }
            }
        }

        select_biased! {
            event = next_relay_event(&mut relay_recvs).fuse() => {
                let (key, result) = event;
                match result {
                    Ok(datagram) => {
                        // Re-arm before handling so the wire keeps
                        // flowing; a retired relay stays retired.
                        let conn = shared.borrow().relay_pool.get(&key).cloned();
                        if let Some(conn) = conn {
                            relay_recvs.push(Box::pin(relay_receive(key, conn)));
                        }
                        if datagram.payload.first() == Some(&SIGNAL_PREFIX) {
                            handle_signal(&shared, key, datagram.source, &datagram.payload[1..]);
                        } else {
                            shared
                                .borrow_mut()
                                .handle_relay_datagram(key, datagram.source, datagram.payload);
                        }
                    }
                    Err(err) => {
                        if key == HOME_RELAY {
                            shared.borrow_mut().mark_dead(&err);
                            break 'pump;
                        }
                        // A foreign relay died; routes naming it starve
                        // and their connections idle out.
                        shared.borrow_mut().relay_pool.remove(&key);
                    }
                }
            },
            received = udp_recv => {
                if let Ok((payload, remote)) = received {
                    udp_recv.set(udp_receive(udp.clone()).fuse());
                    shared.borrow_mut().handle_udp_datagram(remote, payload);
                } else {
                    // The socket died; the relay path continues. Park the
                    // slot terminated — a pending-forever future here
                    // would hang the teardown await below (the self-wake
                    // cannot resolve it through a dead socket).
                    udp_recv.set(futures::future::Fuse::terminated());
                }
            },
            event = next_channel_event(&mut channel_recvs).fuse() => {
                let (id, result) = event;
                match result {
                    Ok(payload) => {
                        // Re-arm before handling so the wire keeps
                        // flowing; a channel retired meanwhile stays
                        // retired.
                        let wire = shared
                            .borrow()
                            .channels
                            .get(&id)
                            .map(|entry| entry.wire.clone());
                        if let Some(wire) = wire {
                            channel_recvs.push(Box::pin(channel_receive(id, wire)));
                        }
                        if let Some(datagram) = payload {
                            shared.borrow_mut().handle_channel_datagram(id, datagram);
                        }
                    }
                    Err(_) => {
                        // The channel died; the peer's route moves back
                        // to the relay.
                        shared.borrow_mut().retire_channel(id);
                    }
                }
            },
            _ = kicked(&shared).fuse() => {
                // A method mutated state needing a flush; the loop top
                // drains and transmits it.
            },
            _ = tick => {
                tick.set(monotonic_clock::wait_for(TICK_NS).fuse());
                shared.borrow_mut().handle_timeouts();
                force_wake = true;
            }
        }
    }

    // No waiter sleeps past the pump: every break path set its terminal
    // state (dead, or closed and drained/lingered) before arriving here.
    shared.borrow_mut().wake_waiters();

    // Resolve the pinned imports before the task ends: close every pool
    // relay and every channel (each pending receive resolves with its
    // closed error), self-wake the UDP socket (a zero-length datagram
    // to our own address resolves its pending receive), and let the
    // final tick fire.
    let relays: Vec<Rc<RelayConn>> = shared.borrow().relay_pool.values().cloned().collect();
    for conn in &relays {
        conn.close();
    }
    if let Some(wire) = &udp {
        let _ = wire.self_wake().await;
    }
    let channel_wires: Vec<Rc<ChannelWire>> = shared
        .borrow()
        .channels
        .values()
        .map(|entry| entry.wire.clone())
        .collect();
    for wire in &channel_wires {
        wire.close();
    }
    while !relay_recvs.is_empty() {
        let _ = relay_recvs.next().await;
    }
    if udp.is_some() && !udp_recv.is_terminated() {
        udp_recv.as_mut().await.ok();
    }
    while !channel_recvs.is_empty() {
        let _ = channel_recvs.next().await;
    }
    if !tick.is_terminated() {
        tick.as_mut().await;
    }
}

type RelayRecvFuture = futures::future::LocalBoxFuture<
    'static,
    (
        u32,
        Result<iroh_endpoint_core::relay_frames::Datagram, String>,
    ),
>;

/// One relay receive, tagged with the relay's pool key.
async fn relay_receive(
    key: u32,
    conn: Rc<RelayConn>,
) -> (
    u32,
    Result<iroh_endpoint_core::relay_frames::Datagram, String>,
) {
    let result = conn.recv_datagram().await;
    (key, result)
}

/// The next completed relay receive, or pending-forever while the pool
/// is empty (only during teardown; the home relay is armed before the
/// first select). The set owns the in-flight import futures.
async fn next_relay_event(
    set: &mut FuturesUnordered<RelayRecvFuture>,
) -> (
    u32,
    Result<iroh_endpoint_core::relay_frames::Datagram, String>,
) {
    if set.is_empty() {
        std::future::pending().await
    } else {
        set.next().await.expect("a non-empty set yields an item")
    }
}

type ChannelRecvFuture =
    futures::future::LocalBoxFuture<'static, (u32, Result<Option<Vec<u8>>, String>)>;

/// One channel receive, tagged with the channel's id.
async fn channel_receive(id: u32, wire: Rc<ChannelWire>) -> (u32, Result<Option<Vec<u8>>, String>) {
    let result = wire.receive().await;
    (id, result)
}

/// The next completed channel receive, or pending-forever while no
/// channel exists (the select needs an arm either way). The set owns
/// the in-flight import futures; this wrapper only polls it, so
/// dropping the wrapper between select turns cancels nothing.
async fn next_channel_event(
    set: &mut FuturesUnordered<ChannelRecvFuture>,
) -> (u32, Result<Option<Vec<u8>>, String>) {
    if set.is_empty() {
        std::future::pending().await
    } else {
        set.next().await.expect("a non-empty set yields an item")
    }
}

/// Inbound signaling: file the payload in the peer's inbox, spawning an
/// answerer session for a peer without one. Discarded entirely when the
/// WebRTC wire is disabled or the endpoint is closing.
fn handle_signal(shared: &Shared, via: u32, source: [u8; 32], payload: &[u8]) {
    /// Unread-signal cap per peer; a flooding peer loses signals, not us.
    const INBOX_CAP: usize = 64;
    let spawn_answerer = {
        let mut st = shared.borrow_mut();
        if !st.webrtc_enabled || st.is_closed_or_dead() {
            return;
        }
        // Claim the slot synchronously with the decision, so a second
        // datagram cannot spawn a second session. The session answers
        // through the relay the offer arrived on.
        let spawn_answerer = !st.signaling.contains_key(&source);
        if spawn_answerer {
            st.signaling.insert(source, via);
        }
        let inbox = st.signal_inboxes.entry(source).or_default();
        if inbox.len() < INBOX_CAP {
            inbox.push_back(payload.to_vec());
        }
        // Inbox pushes bypass `drain`, so the loop-top wake never sees
        // them; wake the session waiters here.
        st.wake_waiters();
        spawn_answerer
    };
    if spawn_answerer {
        wit_bindgen::spawn_local(webrtc::answer(shared.clone(), source));
    }
}

/// The next UDP datagram, or pending-forever without a socket (the pump's
/// select needs one future shape either way).
async fn udp_receive(
    udp: Option<Rc<UdpWire>>,
) -> Result<(Vec<u8>, SocketAddr), crate::bindings::wasi::sockets::types::ErrorCode> {
    match udp {
        Some(wire) => wire.receive().await,
        None => std::future::pending().await,
    }
}

fn other(detail: impl std::fmt::Display) -> Error {
    Error::Other(detail.to_string())
}

/// A synthetic socket address under the IPv6 documentation prefix
/// (RFC 3849, `2001:db8::/32`): `2001:db8:<space>::<hi>:<lo>`, port
/// 4433. Documentation addresses are never routable, so standins
/// cannot collide with real peers.
fn doc_prefix_addr(space: u16, host: u32) -> SocketAddr {
    SocketAddr::new(
        IpAddr::V6(Ipv6Addr::new(
            0x2001,
            0xdb8,
            space,
            0,
            0,
            0,
            (host >> 16) as u16,
            host as u16,
        )),
        4433,
    )
}

/// The pool-key identity of a relay URL: trailing-slash-insensitive.
fn normalize_relay_url(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

/// Run `check` against the shared state until it produces a value,
/// parking a waker in `State::waiters` between attempts. The pump fires
/// the waiters when the state may have changed, and on every tick — a
/// deadline inside `check` is observed at tick granularity.
pub(crate) async fn wait_until<R>(
    shared: &Shared,
    mut check: impl FnMut(&mut State) -> Option<R>,
) -> R {
    std::future::poll_fn(|cx| {
        let mut st = shared.borrow_mut();
        match check(&mut st) {
            Some(result) => Poll::Ready(result),
            None => {
                st.waiters.push(cx.waker().clone());
                Poll::Pending
            }
        }
    })
    .await
}

/// The pump's kick arm: resolves once a resource method kicks the pump,
/// parking the pump's waker meanwhile. Guest-local — re-creating it
/// each select turn cancels no import subtask.
async fn kicked(shared: &Shared) {
    std::future::poll_fn(|cx| {
        let mut st = shared.borrow_mut();
        if st.pump_kicked {
            st.pump_kicked = false;
            Poll::Ready(())
        } else {
            st.pump_waker = Some(cx.waker().clone());
            Poll::Pending
        }
    })
    .await
}

// --- exported resources --------------------------------------------------

pub struct EndpointRes {
    shared: Shared,
    identity: Rc<Identity>,
    udp: Option<Rc<UdpWire>>,
}

impl Drop for EndpointRes {
    fn drop(&mut self) {
        let mut st = self.shared.borrow_mut();
        if !st.closed {
            st.closed = true;
            st.closed_at = Some(Instant::now());
            st.close_all(b"endpoint dropped");
            st.kick_pump();
            st.wake_waiters();
        }
    }
}

pub struct ConnectionRes {
    shared: Shared,
    handle: ConnectionHandle,
}

pub struct SendStreamRes {
    shared: Shared,
    handle: ConnectionHandle,
    id: StreamId,
    /// `write-via-stream`'s one-shot claim (issue #13, finding B6):
    /// once taken, `write` and `finish` are refused.
    streaming: Cell<bool>,
    /// One in-flight `write` at a time (finding B4): concurrent writes
    /// would interleave at flow-control boundaries — byte-level
    /// corruption for framed payloads — so a second is refused.
    writing: Cell<bool>,
    /// Whether `finish` or `reset` ran. Guards the drop-implied
    /// `reset(0)`: noq's `reset` replaces a pending FIN on a finished
    /// stream, so resetting on drop unconditionally would corrupt the
    /// finish-then-drop pattern.
    ended: Cell<bool>,
}

impl SendStreamRes {
    fn new(shared: Shared, handle: ConnectionHandle, id: StreamId) -> Self {
        Self {
            shared,
            handle,
            id,
            streaming: Cell::new(false),
            writing: Cell::new(false),
            ended: Cell::new(false),
        }
    }
}

impl Drop for SendStreamRes {
    fn drop(&mut self) {
        // The drop contract: an unfinished, un-reset stream must not
        // leave the peer waiting forever.
        if !self.ended.get() {
            GuestSendStream::reset(self, 0);
        }
    }
}

pub struct RecvStreamRes {
    shared: Shared,
    handle: ConnectionHandle,
    id: StreamId,
    streaming: Cell<bool>,
    /// The stream's first observed terminal outcome — `Ok` at the FIN,
    /// the failure otherwise — repeated by every later `read`. The
    /// latch keeps the outcome stable: a connection close after a
    /// consumed FIN must not turn the clean end into a failure
    /// (issue #13, finding A2).
    terminal: RefCell<Option<Result<(), Error>>>,
    /// One in-flight `read` at a time (finding B4): concurrent reads
    /// would split the byte sequence between callers, so a second is
    /// refused.
    reading: Cell<bool>,
}

impl RecvStreamRes {
    fn new(shared: Shared, handle: ConnectionHandle, id: StreamId) -> Self {
        Self {
            shared,
            handle,
            id,
            streaming: Cell::new(false),
            terminal: RefCell::new(None),
            reading: Cell::new(false),
        }
    }
}

impl Drop for RecvStreamRes {
    fn drop(&mut self) {
        // The drop contract: a reader that never saw the stream's end
        // tells the peer to stop sending. A spent stream needs
        // nothing; a claimed one belongs to its read-via-stream pump.
        if !self.streaming.get() && self.terminal.borrow().is_none() {
            GuestRecvStream::stop(self, 0);
        }
    }
}

/// Clears an in-flight-operation flag on every exit, including the
/// operation's cancellation (the future dropped at an await point).
struct Unclaim<'a>(&'a Cell<bool>);

impl Drop for Unclaim<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

/// Closes a dial whose `connect` call was cancelled before it
/// resolved. Without it the entry sits un-owned forever: the handshake
/// completes, the peer sees a live connection, and nothing ever closes
/// it (issue #13, finding B5). Disarmed on success; a dial that
/// already failed has `error` set and the close is skipped.
struct DialGuard {
    shared: Shared,
    handle: ConnectionHandle,
    armed: bool,
}

impl Drop for DialGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut st = self.shared.borrow_mut();
        if let Some(entry) = st.conns.get_mut(&self.handle) {
            if entry.error.is_none() && !entry.drained {
                entry.conn.close(
                    Instant::now(),
                    VarInt::from_u32(0),
                    bytes::Bytes::from_static(b"connect cancelled"),
                );
                st.kick_pump();
            }
        }
    }
}

/// Releases a relay-open claim whose `connect` was cancelled mid-open.
/// Without it the slot stays claimed forever and every later dial of
/// that relay waits out the open timeout (issue #13, finding B5).
/// Disarmed once the open resolves either way.
struct RelayClaim {
    shared: Shared,
    normalized: String,
    armed: bool,
}

impl Drop for RelayClaim {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut st = self.shared.borrow_mut();
        st.relay_opening.remove(&self.normalized);
        // Waiters re-check and observe the open's disappearance.
        st.wake_waiters();
    }
}

impl Guest for Component {
    type Endpoint = EndpointRes;
    type EndpointOptions = EndpointOptionsRes;
    type Connection = ConnectionRes;
    type SendStream = SendStreamRes;
    type RecvStream = RecvStreamRes;
}

impl EndpointRes {
    /// The pool key for `url`, opening a connection to the relay when
    /// none exists. Concurrent dials to the same relay share one open:
    /// the first claims the slot, the rest wait for its outcome.
    async fn ensure_relay(&self, url: &str) -> Result<u32, Error> {
        let normalized = normalize_relay_url(url);
        let claimed = {
            let mut st = self.shared.borrow_mut();
            if let Some(key) = st.relay_keys.get(&normalized) {
                return Ok(*key);
            }
            if st.is_closed_or_dead() {
                return Err(Error::Closed);
            }
            st.relay_opening.insert(normalized.clone())
        };
        if claimed {
            // The claim is released on every exit — including this
            // call's cancellation at the await below.
            let mut claim = RelayClaim {
                shared: self.shared.clone(),
                normalized: normalized.clone(),
                armed: true,
            };
            let opened = RelayConn::connect(url, &self.identity).await;
            claim.armed = false;
            let mut st = self.shared.borrow_mut();
            st.relay_opening.remove(&normalized);
            // Concurrent dialers of this relay wait on the outcome.
            st.wake_waiters();
            return match opened {
                Ok(conn) => Ok(st.register_relay(url, Rc::new(conn))),
                Err(e) => Err(Error::ConnectFailed(format!("relay {url}: {e}"))),
            };
        }
        let started = Instant::now();
        wait_until(&self.shared, move |st| {
            if let Some(key) = st.relay_keys.get(&normalized) {
                return Some(Ok(*key));
            }
            if !st.relay_opening.contains(&normalized) {
                return Some(Err(Error::ConnectFailed(
                    "a concurrent open of this relay failed".into(),
                )));
            }
            if st.is_closed_or_dead() {
                return Some(Err(Error::Closed));
            }
            if started.elapsed() > Duration::from_secs(30) {
                return Some(Err(Error::ConnectFailed("relay open timed out".into())));
            }
            None
        })
        .await
    }
}

/// The `endpoint-options` resource: the identity (cloned out of the
/// borrowed resource at construction, so one identity configures any
/// number of endpoints) plus the knobs, defaulting to nothing granted.
pub(crate) struct EndpointOptionsRes {
    state: RefCell<OptionsState>,
}

struct OptionsState {
    identity: Rc<Identity>,
    alpns: Vec<Vec<u8>>,
    relay_url: Option<String>,
    udp_bind_addr: Option<String>,
    webrtc: bool,
}

impl GuestEndpointOptions for EndpointOptionsRes {
    fn new(identity: IdentityBorrow<'_>) -> Self {
        let identity = identity.get::<IdentityRes>().inner.clone();
        Self {
            state: RefCell::new(OptionsState {
                identity,
                alpns: Vec::new(),
                relay_url: None,
                udp_bind_addr: None,
                webrtc: false,
            }),
        }
    }

    fn add_alpn(&self, alpn: Vec<u8>) {
        self.state.borrow_mut().alpns.push(alpn);
    }

    fn relay_url(&self, url: String) {
        self.state.borrow_mut().relay_url = Some(url);
    }

    fn udp_bind_addr(&self, addr: String) {
        self.state.borrow_mut().udp_bind_addr = Some(addr);
    }

    fn webrtc(&self, enabled: bool) {
        self.state.borrow_mut().webrtc = enabled;
    }
}

impl GuestEndpoint for EndpointRes {
    async fn bind(options: EndpointOptions) -> Result<Endpoint, Error> {
        let OptionsState {
            identity,
            alpns,
            relay_url,
            udp_bind_addr,
            webrtc,
        } = options
            .into_inner::<EndpointOptionsRes>()
            .state
            .into_inner();
        let relay_url = relay_url.ok_or(Error::InvalidArgument(
            "bind requires a relay-url (the relay wire is the only path yet)".into(),
        ))?;
        if alpns.is_empty() {
            return Err(Error::InvalidArgument(
                "bind requires at least one alpn".into(),
            ));
        }

        let relay = RelayConn::connect(&relay_url, &identity)
            .await
            .map_err(Error::ConnectFailed)?;

        let mut reset_key = [0u8; 32];
        getrandom::fill(&mut reset_key).map_err(other)?;
        let mut token_master = [0u8; 32];
        getrandom::fill(&mut token_master).map_err(other)?;

        let server_tls = tls::server_config(&identity, alpns).map_err(other)?;
        let server_quic_tls = QuicServerConfig::try_from(Arc::new(server_tls))
            .map_err(|e| Error::Other(format!("server quic config: {e}")))?;
        let mut server_config = ServerConfig::new(
            Arc::new(server_quic_tls),
            Arc::new(TokenKey::new(&token_master)),
        );
        server_config.transport_config(transport_config());
        // The advertisement is the bound the PEER's discovery searches
        // up to (noq clamps by it); both sides must raise it for a
        // raised ceiling to take effect.
        let mut endpoint_config = EndpointConfig::new(Arc::new(ResetKey::new(&reset_key)));
        endpoint_config
            .max_udp_payload_size(MTU_CEILING)
            .expect("MTU_CEILING is within QUIC's payload bounds");
        let noq = NoqEndpoint::new(
            Arc::new(endpoint_config),
            Some(Arc::new(server_config)),
            true,
        );

        let udp = match &udp_bind_addr {
            Some(bind_addr) => Some(Rc::new(
                UdpWire::bind(bind_addr).map_err(Error::InvalidArgument)?,
            )),
            None => None,
        };

        let shared = Rc::new(RefCell::new(State::new(noq, webrtc)));
        // The home relay takes pool key HOME_RELAY; the pump arms its
        // receive on the first turn.
        shared
            .borrow_mut()
            .register_relay(&relay_url, Rc::new(relay));
        wit_bindgen::spawn_local(pump(shared.clone(), udp.clone()));

        Ok(Endpoint::new(EndpointRes {
            shared,
            identity,
            udp,
        }))
    }

    fn id(&self) -> Vec<u8> {
        self.identity.endpoint_id.to_vec()
    }

    fn direct_addr(&self) -> Option<String> {
        self.udp.as_ref().map(|wire| wire.local_addr().to_string())
    }

    async fn connect(&self, addr: EndpointAddr, alpn: Vec<u8>) -> Result<Connection, Error> {
        let peer: [u8; 32] = addr
            .endpoint_id
            .as_slice()
            .try_into()
            .map_err(|_| Error::InvalidArgument("endpoint id is not 32 bytes".into()))?;
        // The dial path: the first parseable `ip` entry when a socket
        // is bound, otherwise a relay — the entry's relay when one
        // names a foreign server (opened into the pool on demand), the
        // home relay when none does. No racing or fallback. A `webrtc`
        // entry is an upgrade hint: the connection starts on the relay
        // and moves to the channel when it opens, signaled through the
        // entry's relay.
        let webrtc_enabled = self.shared.borrow().webrtc_enabled;
        let mut direct: Option<SocketAddr> = None;
        let mut dial_relay: Option<String> = None;
        let mut webrtc_hint: Option<String> = None;
        for entry in &addr.addrs {
            match entry {
                TransportAddr::Relay(url) => {
                    if dial_relay.is_none() {
                        dial_relay = Some(url.clone());
                    }
                }
                TransportAddr::Ip(text) => {
                    if direct.is_none() && self.udp.is_some() {
                        direct = text.parse().ok();
                    }
                }
                TransportAddr::Webrtc(url) if webrtc_enabled => {
                    if webrtc_hint.is_none() {
                        webrtc_hint = Some(url.clone());
                    }
                }
                TransportAddr::Webrtc(_) => {}
                TransportAddr::Custom(_) => {}
            }
        }

        // Resolve pool keys before noq dials; opening a foreign relay
        // awaits its websocket and relay handshake.
        let dial_key = match (&direct, &dial_relay) {
            (None, Some(url)) => self.ensure_relay(url).await?,
            _ => HOME_RELAY,
        };
        let upgrade_key = match (&direct, &webrtc_hint) {
            (None, Some(url)) => Some(self.ensure_relay(url).await?),
            _ => None,
        };

        let tls_config = tls::client_config(&self.identity, peer, vec![alpn]).map_err(other)?;
        let quic_tls = QuicClientConfig::try_from(Arc::new(tls_config))
            .map_err(|e| Error::Other(format!("client quic config: {e}")))?;
        let mut config = ClientConfig::new(Arc::new(quic_tls));
        config.transport_config(transport_config());

        let handle = {
            let mut st = self.shared.borrow_mut();
            if st.dead.is_some() || st.closed {
                return Err(Error::Closed);
            }
            let remote = match direct {
                Some(real) => real,
                None => {
                    let standin = st.addr_for_peer(peer, dial_key);
                    // An explicit dial names where the peer is now; a
                    // standin still routed to some relay follows it (a
                    // channel route is a better wire and stays).
                    if matches!(st.routes.get(&standin), Some(RouteWire::Relay(_))) {
                        st.routes.insert(standin, RouteWire::Relay(dial_key));
                    }
                    standin
                }
            };
            let (handle, conn) = st
                .noq
                .connect(Instant::now(), config, remote, tls::SERVER_NAME)
                .map_err(|e| Error::ConnectFailed(e.to_string()))?;
            st.conns
                .insert(handle, ConnEntry::new(conn, Some(peer), false));
            // The upgrade dance overlaps the handshake; the route flip
            // is invisible to noq (same standin address).
            if let Some(key) = upgrade_key {
                st.pending_upgrades.push((peer, key));
            }
            // Flush the first flight (and spawn the upgrade) now.
            st.kick_pump();
            handle
        };

        // The dial is closed if this call is cancelled while parked
        // below; a completed handshake hands ownership to the returned
        // resource.
        let mut dial = DialGuard {
            shared: self.shared.clone(),
            handle,
            armed: true,
        };
        wait_until(&self.shared, |st| {
            let entry = st.conns.get_mut(&handle).expect("connection entry");
            if let Some(err) = &entry.error {
                // A dial that dies before connecting failed to
                // connect, whatever the mechanism — the peer's refusal
                // and a handshake timeout both arrive as transport
                // closes. Local endpoint closure stays `closed`.
                return Some(Err(match err.clone() {
                    Error::Closed => Error::Closed,
                    Error::Other(msg) => Error::ConnectFailed(msg),
                    other => other,
                }));
            }
            if entry.connected {
                return Some(Ok(()));
            }
            None
        })
        .await?;
        dial.armed = false;

        Ok(Connection::new(ConnectionRes {
            shared: self.shared.clone(),
            handle,
        }))
    }

    async fn accept(&self) -> Result<Connection, Error> {
        let handle = wait_until(&self.shared, |st| {
            if let Some(handle) = st.accept_queue.pop_front() {
                return Some(Ok(handle));
            }
            if st.dead.is_some() || st.closed {
                return Some(Err(Error::Closed));
            }
            None
        })
        .await?;
        Ok(Connection::new(ConnectionRes {
            shared: self.shared.clone(),
            handle,
        }))
    }

    fn close(&self) {
        let mut st = self.shared.borrow_mut();
        if !st.closed {
            st.closed = true;
            st.closed_at = Some(Instant::now());
            st.close_all(b"endpoint closed");
            // Flush the CLOSEs and start the linger; wake the accept
            // and connect waiters watching `closed`.
            st.kick_pump();
            st.wake_waiters();
        }
    }
}

impl Drop for ConnectionRes {
    fn drop(&mut self) {
        // The drop contract: `close(0, "")`. Idempotent on an already
        // closed or failed connection.
        GuestConnection::close(self, 0, String::new());
    }
}

impl ConnectionRes {
    fn with_entry<R>(&self, f: impl FnOnce(&mut ConnEntry) -> R) -> R {
        let mut st = self.shared.borrow_mut();
        let entry = st.conns.get_mut(&self.handle).expect("connection entry");
        f(entry)
    }

    async fn open_stream(&self, dir: Dir) -> Result<StreamId, Error> {
        let handle = self.handle;
        let mut kicked_blocked = false;
        wait_until(&self.shared, move |st| {
            let entry = st.conns.get_mut(&handle).expect("connection entry");
            if let Some(err) = &entry.error {
                return Some(Err(err.clone()));
            }
            match entry.conn.streams().open(dir) {
                Some(id) => Some(Ok(id)),
                None => {
                    // Blocked on stream credit: flush the
                    // STREAMS_BLOCKED once so the peer knows.
                    if !kicked_blocked {
                        kicked_blocked = true;
                        st.kick_pump();
                    }
                    None
                }
            }
        })
        .await
    }

    async fn accept_stream(&self, dir: Dir) -> Result<StreamId, Error> {
        let handle = self.handle;
        wait_until(&self.shared, |st| {
            let entry = st.conns.get_mut(&handle).expect("connection entry");
            let queue = match dir {
                Dir::Bi => &mut entry.bi_queue,
                Dir::Uni => &mut entry.uni_queue,
            };
            if let Some(id) = queue.pop_front() {
                return Some(Ok(id));
            }
            entry.error.as_ref().map(|err| Err(err.clone()))
        })
        .await
    }

    fn stream_pair(&self, id: StreamId) -> (SendStream, RecvStream) {
        (
            SendStream::new(SendStreamRes::new(self.shared.clone(), self.handle, id)),
            RecvStream::new(RecvStreamRes::new(self.shared.clone(), self.handle, id)),
        )
    }
}

impl GuestConnection for ConnectionRes {
    fn peer(&self) -> Vec<u8> {
        self.with_entry(|e| e.peer.map(|p| p.to_vec()).unwrap_or_default())
    }

    fn alpn(&self) -> Vec<u8> {
        self.with_entry(|e| e.alpn.clone())
    }

    fn state(&self) -> ConnectionState {
        self.with_entry(|e| {
            if e.drained || e.error.is_some() {
                ConnectionState::Closed
            } else if e.connected {
                ConnectionState::Open
            } else {
                ConnectionState::Connecting
            }
        })
    }

    fn path(&self) -> PathKind {
        let st = self.shared.borrow();
        let Some(entry) = st.conns.get(&self.handle) else {
            return PathKind::Relay;
        };
        // Wire moves are route flips under a stable standin address, so
        // the connection's one path (multipath is never negotiated) keys
        // the route table.
        let Ok(path) = entry.conn.network_path(PathId::ZERO) else {
            return PathKind::Relay;
        };
        match st.routes.get(&path.remote()) {
            Some(RouteWire::Channel(_)) => PathKind::Webrtc,
            Some(RouteWire::Relay(_)) => PathKind::Relay,
            // Real addresses are never in the route table.
            None => PathKind::Ip,
        }
    }

    async fn open_bi(&self) -> Result<(SendStream, RecvStream), Error> {
        let id = self.open_stream(Dir::Bi).await?;
        Ok(self.stream_pair(id))
    }

    async fn open_uni(&self) -> Result<SendStream, Error> {
        let id = self.open_stream(Dir::Uni).await?;
        Ok(SendStream::new(SendStreamRes::new(
            self.shared.clone(),
            self.handle,
            id,
        )))
    }

    async fn accept_bi(&self) -> Result<(SendStream, RecvStream), Error> {
        let id = self.accept_stream(Dir::Bi).await?;
        Ok(self.stream_pair(id))
    }

    async fn accept_uni(&self) -> Result<RecvStream, Error> {
        let id = self.accept_stream(Dir::Uni).await?;
        Ok(RecvStream::new(RecvStreamRes::new(
            self.shared.clone(),
            self.handle,
            id,
        )))
    }

    fn max_datagram_size(&self) -> Option<u32> {
        self.with_entry(|e| e.conn.datagrams().max_size().map(|s| s as u32))
    }

    fn send_datagram(&self, data: Vec<u8>) -> Result<(), Error> {
        let result = self.with_entry(|e| {
            if let Some(err) = &e.error {
                return Err(err.clone());
            }
            // drop=true: a full send buffer discards the oldest queued
            // datagrams (the WIT's lossy-transport ruling), so `Blocked`
            // cannot come back.
            e.conn
                .datagrams()
                .send(bytes::Bytes::from(data), true)
                .map_err(|err| match err {
                    noq_proto::SendDatagramError::TooLarge => {
                        Error::InvalidArgument("datagram exceeds max-datagram-size".into())
                    }
                    noq_proto::SendDatagramError::UnsupportedByPeer => {
                        Error::InvalidArgument("peer does not accept datagrams".into())
                    }
                    other => Error::Other(format!("send-datagram: {other}")),
                })
        });
        if result.is_ok() {
            // Flush the queued datagram.
            self.shared.borrow_mut().kick_pump();
        }
        result
    }

    async fn recv_datagram(&self) -> Result<Vec<u8>, Error> {
        let handle = self.handle;
        wait_until(&self.shared, |st| {
            let entry = st.conns.get_mut(&handle).expect("connection entry");
            if let Some(bytes) = entry.conn.datagrams().recv() {
                return Some(Ok(bytes.to_vec()));
            }
            entry.error.as_ref().map(|err| Err(err.clone()))
        })
        .await
    }

    fn close(&self, code: u64, reason: String) {
        let mut st = self.shared.borrow_mut();
        let entry = st.conns.get_mut(&self.handle).expect("connection entry");
        if entry.error.is_none() && !entry.drained {
            entry.conn.close(
                Instant::now(),
                app_code(code),
                bytes::Bytes::from(reason.into_bytes()),
            );
            // Flush the CONNECTION_CLOSE.
            st.kick_pump();
        }
    }

    async fn wait_closed(&self) -> Option<CloseInfo> {
        let handle = self.handle;
        wait_until(&self.shared, |st| {
            let entry = st.conns.get_mut(&handle).expect("connection entry");
            (entry.drained || entry.error.is_some()).then(|| entry.peer_close.clone())
        })
        .await
    }
}

/// Write all of `bytes`, parking through flow control as needed.
async fn write_all(
    shared: &Shared,
    handle: ConnectionHandle,
    id: StreamId,
    bytes: Vec<u8>,
) -> Result<(), Error> {
    let mut offset = 0usize;
    wait_until(shared, move |st| {
        let entry = st.conns.get_mut(&handle).expect("connection entry");
        if let Some(err) = &entry.error {
            return Some(Err(err.clone()));
        }
        let pass_start = offset;
        let outcome = loop {
            match entry.conn.send_stream(id).write(&bytes[offset..]) {
                Ok(written) => {
                    offset += written;
                    if offset == bytes.len() {
                        break Some(Ok(()));
                    }
                    if written == 0 {
                        break None;
                    }
                }
                Err(WriteError::Blocked) => break None,
                Err(WriteError::Stopped(code)) => {
                    break Some(Err(Error::Reset(code.into_inner())));
                }
                Err(WriteError::ClosedStream) => break Some(Err(Error::Closed)),
            }
        };
        if offset > pass_start {
            // Flush what this pass buffered, complete or not.
            st.kick_pump();
        }
        outcome
    })
    .await
}

/// Read up to `max` bytes; `Ok(None)` at the peer's FIN — the only
/// clean end. A failure is the stream's terminal outcome: the peer's
/// reset, or the connection dying first. Bytes noq already delivered
/// drain before a connection-level failure surfaces.
async fn read_some(
    shared: &Shared,
    handle: ConnectionHandle,
    id: StreamId,
    max: u32,
) -> Result<Option<Vec<u8>>, Error> {
    wait_until(shared, move |st| {
        let entry = st.conns.get_mut(&handle).expect("connection entry");
        // Cloned before the stream borrow; consulted only once the
        // stream itself has nothing more to deliver.
        let conn_failure = entry.error.clone();
        let mut recv = entry.conn.recv_stream(id);
        let mut chunks = match recv.read(true) {
            Ok(chunks) => chunks,
            // The stream's state is gone: spent by a consumed reset,
            // or torn down with the connection. (A consumed FIN never
            // re-enters: `read` latches it.)
            Err(ReadableError::ClosedStream) => {
                return Some(match conn_failure {
                    Some(err) => Err(err),
                    None => Ok(None),
                });
            }
            Err(ReadableError::IllegalOrderedRead) => {
                return Some(Err(other("illegal ordered read")))
            }
        };
        let result = chunks.next(max as usize);
        let _ = chunks.finalize();
        match result {
            Ok(Some(chunk)) => {
                // Consuming frees receive window; flush the credit
                // update so the sender is not left blocked.
                st.kick_pump();
                Some(Ok(Some(chunk.bytes.to_vec())))
            }
            Ok(None) => {
                // The consumed FIN retires the stream; flush the
                // credit it releases.
                st.kick_pump();
                Some(Ok(None))
            }
            // Nothing readable now. With the connection failed nothing
            // ever will be, and the stream did not reach its FIN — a
            // connection close must not read as one (issue #13,
            // finding A2).
            Err(ReadError::Blocked) => match conn_failure {
                Some(err) => Some(Err(err)),
                None => None,
            },
            Err(ReadError::Reset(code)) => Some(Err(Error::Reset(code.into_inner()))),
        }
    })
    .await
}

impl SendStreamRes {
    /// `finish` without the claim checks: `write-via-stream` finishes
    /// its own claimed stream through here.
    fn do_finish(&self) -> Result<(), Error> {
        self.ended.set(true);
        let mut st = self.shared.borrow_mut();
        let entry = st.conns.get_mut(&self.handle).expect("connection entry");
        if let Some(err) = &entry.error {
            return Err(err.clone());
        }
        match entry.conn.send_stream(self.id).finish() {
            Ok(()) => {
                // Flush the FIN.
                st.kick_pump();
                Ok(())
            }
            Err(FinishError::Stopped(code)) => Err(Error::Reset(code.into_inner())),
            Err(FinishError::ClosedStream) => Err(Error::Closed),
        }
    }
}

impl GuestSendStream for SendStreamRes {
    async fn write(&self, bytes: Vec<u8>) -> Result<(), Error> {
        if self.streaming.get() {
            return Err(other("the stream's writes were taken by write-via-stream"));
        }
        if self.writing.replace(true) {
            return Err(other("a write is already in flight on this stream"));
        }
        let _claim = Unclaim(&self.writing);
        write_all(&self.shared, self.handle, self.id, bytes).await
    }

    fn finish(&self) -> Result<(), Error> {
        if self.streaming.get() {
            return Err(other("the stream's writes were taken by write-via-stream"));
        }
        if self.writing.get() {
            // A FIN under an in-flight write would truncate it.
            return Err(other("a write is in flight on this stream"));
        }
        self.do_finish()
    }

    fn reset(&self, code: u64) {
        self.ended.set(true);
        let mut st = self.shared.borrow_mut();
        let entry = st.conns.get_mut(&self.handle).expect("connection entry");
        let _ = entry.conn.send_stream(self.id).reset(app_code(code));
        // Flush the RESET_STREAM.
        st.kick_pump();
    }

    async fn write_via_stream(&self, mut data: StreamReader<u8>) -> Result<(), Error> {
        if self.streaming.get() {
            return Err(other("write-via-stream may be called once"));
        }
        if self.writing.replace(true) {
            // Refused without claiming: the call had no effect.
            return Err(other("a write is already in flight on this stream"));
        }
        let _claim = Unclaim(&self.writing);
        self.streaming.set(true);
        loop {
            let (result, buf) = data.read(Vec::with_capacity(16 * 1024)).await;
            if !buf.is_empty() {
                write_all(&self.shared, self.handle, self.id, buf).await?;
            }
            match result {
                wit_bindgen::StreamResult::Complete(_) => {}
                wit_bindgen::StreamResult::Dropped | wit_bindgen::StreamResult::Cancelled => break,
            }
        }
        self.do_finish()
    }
}

impl GuestRecvStream for RecvStreamRes {
    async fn read(&self, max: u32) -> Result<Option<Vec<u8>>, Error> {
        if self.streaming.get() {
            return Err(other("the stream's bytes were taken by read-via-stream"));
        }
        if let Some(terminal) = self.terminal.borrow().clone() {
            return terminal.map(|()| None);
        }
        if max == 0 {
            return Ok(Some(Vec::new()));
        }
        if self.reading.replace(true) {
            return Err(other("a read is already in flight on this stream"));
        }
        let _claim = Unclaim(&self.reading);
        match read_some(&self.shared, self.handle, self.id, max).await {
            Ok(Some(bytes)) => Ok(Some(bytes)),
            Ok(None) => {
                *self.terminal.borrow_mut() = Some(Ok(()));
                Ok(None)
            }
            Err(err) => {
                *self.terminal.borrow_mut() = Some(Err(err.clone()));
                Err(err)
            }
        }
    }

    fn stop(&self, code: u64) {
        let mut st = self.shared.borrow_mut();
        let entry = st.conns.get_mut(&self.handle).expect("connection entry");
        let _ = entry.conn.recv_stream(self.id).stop(app_code(code));
        // Flush the STOP_SENDING.
        st.kick_pump();
    }

    fn read_via_stream(
        &self,
    ) -> Result<(StreamReader<u8>, FutureReader<Result<(), Error>>), Error> {
        if self.streaming.replace(true) {
            return Err(other("read-via-stream may be called once"));
        }
        let (mut writer, reader) = wit_stream::new();
        // The default never surfaces: every pump path below writes an
        // explicit outcome (a dropped FutureWriter writes its default).
        let (done, done_reader) =
            wit_future::new(|| Err(other("read-via-stream ended without a report")));
        let shared = self.shared.clone();
        let handle = self.handle;
        let id = self.id;
        wit_bindgen::spawn_local(async move {
            let outcome = loop {
                match read_some(&shared, handle, id, 16 * 1024).await {
                    Ok(Some(bytes)) => {
                        let remaining = writer.write_all(bytes).await;
                        if !remaining.is_empty() {
                            // The consumer dropped the byte stream:
                            // delivery is abandoned, and without
                            // consuming, how the stream ends cannot be
                            // learned.
                            break Err(other(
                                "read-via-stream abandoned: the byte stream was dropped",
                            ));
                        }
                    }
                    Ok(None) => break Ok(()),
                    Err(err) => break Err(err),
                }
            };
            drop(writer);
            let _ = done.write(outcome).await;
        });
        Ok((reader, done_reader))
    }
}
