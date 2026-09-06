# `component-iroh`

A portable implementation of [iroh](https://iroh.computer) as WebAssembly
components: the same endpoint logic running in browsers, on personal
devices, and on cloud providers, interconnecting wasm components across
all three — built on the
[`polymorph:webcrypto`](https://github.com/polymorph-components/polymorph-webcrypto),
[`polymorph:webrtc-datachannels`](https://github.com/polymorph-components/polymorph-webrtc-datachannels),
and [`polymorph:websocket`](https://github.com/polymorph-components/polymorph-websocket)
packages and the
[`polymorph-test`](https://github.com/polymorph-components/polymorph-test) machinery.

Status: **proposal**. This README records the design research and the
rulings it produced; open questions are tracked in the
[issues](../../issues).

## Releases

Everything here is **unstable** (0.x), but [releases](../../releases) are
**caret-honest**: within a minor line they stay backward-compatible, and
anything breaking bumps the minor. Consumption is pinned at a release's
commit — sibling checkouts and vendored WIT at pinned release commits,
the release-pinned polyengine/JSR graph — and bumped deliberately.

## What iroh is, layer by layer

Iroh's stack, per its own documentation, is a set of small layers with a
deliberately swappable bottom:

- **Transport** carries encrypted bytes: UDP by default, relay as
  fallback, explicitly pluggable (Tor, Nym, Bluetooth exist upstream).
- **QUIC + TLS 1.3** (upstream: noq + rustls) provides end-to-end
  encryption, authentication, and stream multiplexing. Node identity is an
  Ed25519 key; TLS authenticates raw public keys, so the key *is* the
  address (`EndpointID`).
- **Endpoint** finds peers (signed DNS records published over HTTPS,
  optional Mainline DHT), traverses NATs (`n0_nat_traversal`, a QUIC
  extension inspired by the
  [QUIC NAT traversal draft](https://datatracker.ietf.org/doc/draft-seemann-quic-nat-traversal/)),
  keeps a secure WebSocket open to a home relay, and migrates paths
  transparently.
- **Router** dispatches incoming connections to protocol handlers by ALPN.
- **Protocols** (blobs, gossip, docs, yours) define what peers do once
  connected.

The transport layer being pluggable is the load-bearing fact for this
project: it is the seam where the browser gets a real peer-to-peer path.

## The architecture

### Port the protocol, not the crate

Compiling iroh itself (noq, tokio, rustls) to a component target is the
wrong shape: tokio's WASI support is partial, noq's socket layer is tokio-coupled,
and iroh's existing browser build targets wasm-bindgen, not components.
Instead, the endpoint layer is reimplemented around a **sans-I/O QUIC
core** (`noq-proto` is already sans-I/O), driven by a component-model
async pump, with transports and crypto injected through WIT — the same
pattern as the webrtc sibling's in-guest provider, which drives the
sans-I/O `rtc` stack over `wasi:sockets`. Iroh's *wire formats* (discovery
records, relay protocol, the NAT-traversal extension, ALPN dispatch) are
reused so that native component-iroh nodes interoperate with upstream iroh
nodes on UDP paths.

### Transports through WIT

| Path | Transport | Who serves it |
| --- | --- | --- |
| native ↔ native | UDP datagrams | `wasi:sockets`; hole punching via iroh's `n0_nat_traversal` inside the QUIC connection |
| browser ↔ anything, direct | WebRTC data channel (unreliable, unordered — a datagram carrier) | `polymorph:webrtc-datachannels`: browser host in the browser, Wasmtime host (webrtc-rs) on native peers, in-guest sans-I/O stack elsewhere; ICE does the hole punching on this path |
| any ↔ relay | WebSocket to the home relay | `polymorph:websocket` (the package created for this gap: `wasi:http` has no upgrade path) |
| discovery | HTTPS (publish + resolve signed records) | `wasi:http`; Mainline DHT lookup is native-only and optional (needs UDP) |

**QUIC runs end-to-end on every path.** This is the central design ruling.
The browser leg tunnels QUIC packets through an unreliable data channel
rather than using SCTP streams directly. The costs are real — double
encryption (DTLS+SCTP beneath QUIC), MTU shrinkage, SCTP quirks under
QUIC's congestion controller — and are accepted, because the alternative
forks the endpoint layer: two auth models, two stream semantics, and
iroh's promises (one `EndpointID`, transparent migration, end-to-end QUIC
auth) held on only one leg. With QUIC uniform, every peer speaks one
protocol; WebRTC is just a wire that appears when a browser is on one end,
and its signaling rides the relay connection both sides already hold.
Upstream iroh nodes remain reachable over plain UDP/QUIC; the WebRTC
transport extends reach beyond what upstream's browser story (relay-only
over WebSocket, no direct connections) can do.

### The crypto split: `polymorph:webcrypto` for identity, `polymorph:tls` in-guest

`polymorph:webcrypto` serves **identity**; everything else runs **in-guest**
under the [`polymorph:tls`](https://github.com/polymorph-components/polymorph-tls) sibling's
wasm timing-class profile (its `polymorph-tls-quic` crate — ChaCha20-Poly1305
preferred, fixsliced AES-128-GCM for conformance, RFC 9001 packet
protection, noq session glue). Specifically:

- Node identity (Ed25519 signing) and discovery-record signing go through
  the WIT surface: the identity key is a *non-extractable* handle — in the
  browser, once webcrypto's platform-backed key storage lands, a
  browser-resident key — a strictly better posture than upstream
  iroh-in-wasm holding the seed in linear memory. This is TLS 1.3's one
  class-D-shaped surface (the endpoint's own CertificateVerify), and
  delegation closes it exactly as the `polymorph:tls` profile prescribes.
- Key exchange (class B, per-connection blast radius), handshake
  verification (secret-free), the key schedule, and per-packet record
  protection (AEAD + header protection) run in-guest. Per-packet
  operations across a component boundary were never viable (an async
  `crypto.subtle` round trip per packet, and header protection wants raw
  AES-ECB single-block, which WebCrypto does not offer); the handshake
  asymmetrics moved in-guest when `polymorph:tls` landed, because each
  boundary crossing is the dominant browser-path handshake cost (measured
  in issue #4) and the profile's timing classification covers them. The
  original all-through-webcrypto handshake remains reconstructible by
  provider composition if a runtime's timing story demands it.

### Deployment matrix

The family's standing triangle, applied to a whole endpoint:

- **Browser**: transpiled or runtime-linked, `polymorph:webcrypto` and
  `polymorph:webrtc-datachannels` served by the browser hosts over Web Crypto
  and `RTCPeerConnection`, `polymorph:websocket` over the browser `WebSocket`.
- **Native / cloud**: Wasmtime, the host crates
  (`add_to_linker` + view traits) over RustCrypto, webrtc-rs, and native
  sockets; UDP directly via `wasi:sockets`.
- **Fully in-guest**: composed via `wac plug` with the in-guest providers,
  importing only `wasi:sockets`/`wasi:clocks`/`wasi:http` — the maximally
  portable, minimally trusting configuration.

One guest binary, three targets, conformance as the gate — the property
the sibling repositories exist to demonstrate, exercised here at protocol
scale.

## What this buys over upstream iroh

- **Browser peers with direct connections.** Upstream iroh in the browser
  is relay-only. ICE gives component-iroh browser↔browser and
  browser↔native direct paths.
- **One artifact across environments.** The same component runs in a
  browser tab, on a phone runtime, and in a server-side Wasmtime — the
  component model's portability promise applied to the networking stack
  itself.
- **Capability-bounded networking for components.** A wasm component gets
  peer connectivity through narrow WIT imports rather than ambient
  sockets.
- **Non-extractable node identity** on platforms with key storage.

## The implementation

QUIC runs end to end between component instances on every wire the
design names: a WebRTC data channel, an iroh relay connection, and
direct UDP. The rulings this settled — the crypto split (issue #5,
Path A), the transport profile (issue #1), and iroh's relay wire
protocol against an unmodified upstream relay (issue #2) — are
recorded below.

(A single-connection spike demo, `guest/` plus its own host driver,
carried this code first and was retired once the endpoint component
superseded it; the history is in the git log.)

- **One guest component** (`endpoint/`, `wasm32-wasip2`): `noq-proto`
  with default features off over the `polymorph:tls` sibling's
  `polymorph-tls-quic` crypto layer, implementing the crypto split —
  key exchange, peer verification, the key schedule, and record/packet
  protection run in-guest under the wasm timing-class profile, while
  Ed25519 identity signing goes through `polymorph:webcrypto` (the
  identity key is a non-extractable handle). rustls's synchronous
  signing callback bridges to the async import with
  `wit_bindgen::block_on`, which is legal because the demo's only
  export (`demo.run`) is async-lifted.
- **Iroh-style identity**: TLS authenticates raw public keys (RFC 7250);
  the Ed25519 key in the SPKI is the endpoint ID. Signaling only
  *claims* an identity; the handshake authenticates it, and the two
  must agree.
- **A stock iroh relay serves the relay leg.** Each peer opens a
  `polymorph:websocket` connection to an unmodified upstream
  [`iroh-relay`](https://github.com/n0-computer/iroh/tree/main/iroh-relay)
  server and speaks iroh's relay wire protocol: the websocket subprotocol
  negotiation, the challenge-response authentication handshake (the
  browser-compatible path; the challenge signature comes from the
  webcrypto identity handle), and datagram frames addressed by endpoint
  ID. Frame encodings are pinned by known-answer tests mirroring
  upstream's own snapshot vectors. What the endpoint requires of a
  relay is exactly that subset — ws(s) upgrade at `/relay`, the
  `iroh-relay-v2`/`v1` subprotocols, challenge auth, datagram
  forwarding, pings answered; it sends no QAD probes (address
  discovery for the native UDP path is issue #12's scope, and a
  browser leg has no UDP address to discover). This holds against
  production deployments, not just the pinned checkout: `just
  interop-prod` runs the echo, the WebRTC upgrade (signaling forwarded
  by the production relay), and a cross-relay dial against n0's public
  relay infrastructure over wss, unmodified. No component-iroh relay
  flavor is needed.
- **Pairing is by endpoint ID**, iroh's model: the demo prints its ID at
  startup, the client is handed the server's (`--peer`), and a server
  learns the client's from the relay-authenticated source of the first
  inbound frame. The handshake-authenticated TLS key must agree with the
  relay-authenticated source — there is no separate identity exchange.
- **Three wires, one endpoint**: QUIC runs end-to-end over an
  unreliable, unordered data channel (`ordered=false`,
  `max-retransmits=0`, SDP/ICE signaling carried as relay datagrams),
  over the relay itself as raw QUIC packets in relay datagram frames
  (the relay never holds connection keys), or over direct UDP. One QUIC
  datagram rides in one frame on either carrier; GSO batching is
  disabled, and packet size starts at QUIC's 1200-byte floor and is
  discovered per path up to a 4 KiB ceiling (issue #47) — the relay and
  data-channel wires have no real MTU, so they converge on the ceiling
  while a UDP path finds the true one.
- **Every pairing exercised, plus upstream interop**: the Wasmtime
  host (`host-wasmtime/`, the sibling host crates) runs authenticated
  echoes on every wire through the stock relay, and the polyengine JS host
  (`host-polyengine/`) runs the same surface on stock Deno.

To run it: build the components, hosts, and the upstream relay, then
hand the server's printed endpoint ID to the client
(`WEBRTC_INCLUDE_LOOPBACK=1` lets same-host peers pair on the WebRTC
wire):

```sh
./scripts/setup.sh   # pinned tools + the iroh-relay binary, npm installs
just build           # components + host binaries
iroh-relay --dev &   # ws on 127.0.0.1:3340
WEBRTC_INCLUDE_LOOPBACK=1 target/host/endpoint-demo \
  target/components/iroh-demo.wasm \
  --role server --relay http://127.0.0.1:3340 --webrtc &
# scrape the server's `endpoint-id <hex>` line, then:
WEBRTC_INCLUDE_LOOPBACK=1 target/host/endpoint-demo \
  target/components/iroh-demo.wasm \
  --role client --relay http://127.0.0.1:3340 --webrtc --peer <endpoint-id>
```

Drop `--webrtc` on both sides to keep QUIC on the relay wire, or add
`--udp-bind`/`--direct` for the UDP path.

### The endpoint component

The designed surface (`wit/iroh.wit`, issue #3) has a first
implementation: `endpoint/` exports `polymorph:iroh/endpoint@0.1.0` —
`bind`/`connect`/`accept` by endpoint ID, multiple connections, QUIC
streams as resources — over three wires behind one surface: the relay
(a pooled set, so peers on foreign relays are dialable), direct UDP
via `wasi:sockets`, and WebRTC data channels as a background upgrade
(a relay-dialed connection moves onto the channel when it opens;
`connection.path` reports the move). Upstream interop is proven both
ways over UDP against iroh v1.1.0, and against n0's production relay
infrastructure over wss. `endpoint-demo/` is the first consumer,
composed via `wac plug` and driven by
`host-wasmtime/src/bin/endpoint-demo.rs`. Internally: one detached pump
task per bound endpoint owns all I/O, and wake-ups are event-driven in
both directions — resource methods kick the pump to flush their
mutations and park on wakers the pump fires (cross-task wakeups ride
wit-bindgen's `inter-task-wakeup` channel, delivered by both hosts).
The JS host for this surface is `host-polyengine/`: it drives the endpoint
component runtime-linked under [polyengine](https://github.com/polymorph-components/polyengine)
on stock Deno (no transpile step, no engine flag) — the jco host this
repository ran previously blocked on an upstream jco scheduler defect
(the detached-pump shape polyengine's scheduler serves instead) and has
retired. `just exam-polyengine` runs
its seven-scenario endpoint exam — bind + identity (including the
no-UDP profile's `not-supported`), relay echo, the WebRTC upgrade,
the issue #10 concurrency rows as passing assertions, the stream
terminal outcomes, idle survival, and teardown.

`just matrix` runs every claimed pairing — the composed endpoint demo
on every wire, cross-relay and upstream interop included, plus the
surface's negative probes — against stock `iroh-relay` servers; `just
bench` gates the measured claims; `just exam-polyengine` gates the
polyengine-hosted endpoint surface; `just ci` is the full gate. `just
interop-prod` (manual, internet-dependent) checks the production
relays.

## Open questions

Tracked as issues; the headline ones:

- The endpoint surface's remaining half (issue #3): router-style
  composition (multiple ALPN protocols behind one endpoint) and QUIC
  datagrams.
- Direct UDP as an upgrade target (issue #12): disco-style datagram
  attribution and reachability probing, the native half of address
  discovery.
- The jco browser leg (issue #10): resolved by moving the JS host to
  polyengine (`host-polyengine/`), which serves the detached-pump shape jco's
  scheduler could not; the jco host and its scheduler-defect
  workarounds have retired. Root cause and partial upstream fix
  attempts remain recorded on lann/jco#11 and PR #27 for reference.
