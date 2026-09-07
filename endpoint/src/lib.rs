//! The `polymorph:iroh` endpoint component: `connect`/`accept` by endpoint ID,
//! QUIC end-to-end, over the iroh relay wire, direct UDP, and WebRTC
//! data channels.
//!
//! One `bind` mints an identity, opens the home relay connection, binds
//! the UDP socket when asked, and spawns a detached pump task that owns
//! all I/O: relay, UDP, and channel datagrams in and out, WebRTC
//! signaling dispatch, noq's timers, and the wake-ups for every future
//! a resource method parked. Resource methods mutate the shared noq
//! state directly and kick the pump to flush the consequences.
//!
//! v0 narrowings (each a recorded latitude, not a design ruling): the
//! dial path is `ip` (with a bound socket) or a relay — the entry's
//! foreign relay joins a pool on demand, the home relay otherwise; no
//! racing or fallback between dial paths; a `webrtc` entry upgrades a
//! relay-dialed connection in the background (flip on channel open,
//! flip back on channel death — no quality-based selection); `custom`
//! entries are ignored; one signaling session per peer at a time; a
//! foreign relay's death starves its routes rather than failing them;
//! and `bind` requires a home relay URL.

mod endpoint_impl;
mod identity;
mod udp;
mod webrtc;

pub(crate) mod bindings {
    // `generate!` cannot read cfg, and the `@unstable` WIT feature must be
    // named in `features:` only when the cargo feature is on; so the one
    // shared invocation lives in a macro, expanded once per cfg arm.
    macro_rules! bind {
        ($($features:tt)*) => {
            wit_bindgen::generate!({
                path: "../wit",
                world: "iroh-endpoint",
                generate_all,
                $($features)*
                // The websocket interfaces are bound once in iroh-endpoint-core,
                // whose relay client this component shares; webrtc's structurally
                // equal `stream-message` is then the only stream payload generated
                // in this crate — two in one generation collide under wit-bindgen
                // 0.59's structural canonicalization of stream payloads.
                //
                // The webcrypto interfaces are bound once in polymorph-webcrypto-guest,
                // whose newtypes wrap only that generation; `endpoint-options.identity`
                // carries `signature` handles, so those interfaces (and their type
                // dependencies) must resolve to the same resource types the SDK
                // wraps.
                with: {
                    "polymorph:websocket/types@0.1.0": iroh_endpoint_core::bindings::polymorph::websocket::types,
                    "polymorph:websocket/connections@0.1.0": iroh_endpoint_core::bindings::polymorph::websocket::connections,
                    "polymorph:webcrypto/types@0.1.0": polymorph_webcrypto_guest::bindings::types,
                    "polymorph:webcrypto/wrapping@0.1.0": polymorph_webcrypto_guest::bindings::wrapping,
                    "polymorph:webcrypto/signature@0.1.0": polymorph_webcrypto_guest::bindings::signature,
                },
            });
        };
    }

    #[cfg(feature = "guest-ed25519-signing")]
    bind!(features: ["guest-ed25519-signing"],);
    #[cfg(not(feature = "guest-ed25519-signing"))]
    bind!();
}

bindings::export!(Component with_types_in bindings);

pub(crate) struct Component;
