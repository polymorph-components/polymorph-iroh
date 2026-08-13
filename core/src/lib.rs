//! The shared endpoint core: everything the endpoint component builds
//! on — the webcrypto-held identity, the
//! raw-public-key TLS configuration over the `polymorph:tls` sibling's
//! profile, the iroh relay wire framing, and the relay client over
//! `polymorph:websocket`.
//!
//! The crypto split, amended after `polymorph:tls` landed: identity signing
//! goes through `polymorph:webcrypto` (the key is a non-extractable handle);
//! key exchange, verification, the key schedule, and record/packet
//! protection run in-guest via `polymorph-tls-quic`'s wasm timing-class
//! profile. Modules that reach a WIT import are wasm-only; relay framing
//! compiles natively for its known-answer tests.

pub mod crypto;
pub mod relay_frames;

#[cfg(target_arch = "wasm32")]
pub mod bindings {
    //! The `wit-bindgen` bindings for the interfaces the wasm-only modules
    //! import, bound once here: components remap their worlds' matching
    //! imports onto this module (`with` in their `generate!`), so one Rust
    //! type serves every crate in the build.
    wit_bindgen::generate!({
        path: "wit",
        world: "core-imports",
        generate_all,
    });
}

#[cfg(target_arch = "wasm32")]
pub mod relay;

#[cfg(target_arch = "wasm32")]
pub mod tls;
