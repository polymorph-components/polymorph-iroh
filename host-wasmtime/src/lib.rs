//! The Wasmtime host drivers' shared embedding: one store context, one
//! set of `*View` impls, and the linker/engine setup every driver
//! needs.
//!
//! The drivers are separate binaries (they compile in parallel, which
//! is what keeps the host build's wall time down — see PR #67's
//! measurements), and each expands its own `bindgen!` world. What they
//! do NOT need to repeat is this: the context type, its four view
//! impls, the engine configuration, and the add-to-linker sequence,
//! all of which monomorphize wasmtime's component-model machinery over
//! one `Ctx`. Compiling that once here is the point of this crate.

use polymorph_webcrypto_wasmtime::{WasiWebcryptoCtx, WasiWebcryptoCtxView, WasiWebcryptoView};
use wasmtime::component::{HasData, Linker, ResourceTable};
use wasmtime::{Config, Engine, Result, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};
use wasmtime_webrtc_datachannels::{self as webrtc_host, WebrtcCtx, WebrtcCtxView, WebrtcView};
use wasmtime_websocket::{WasiWebsocketCtx, WasiWebsocketCtxView, WasiWebsocketView};

/// The store context every driver runs on: WASI plus the three sibling
/// host implementations. Drivers that use only a subset (the
/// exec-model probes need no wire) carry the unused contexts inertly —
/// they cost an idle struct field, not a compile of their own.
pub struct Ctx {
    pub wasi: WasiCtx,
    pub webrtc: WebrtcCtx,
    pub webcrypto: WasiWebcryptoCtx,
    pub websocket: WasiWebsocketCtx,
    pub table: ResourceTable,
}

impl HasData for Ctx {
    type Data<'a> = &'a mut Self;
}

impl WasiView for Ctx {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl WebrtcView for Ctx {
    fn webrtc(&mut self) -> WebrtcCtxView<'_> {
        WebrtcCtxView {
            ctx: &mut self.webrtc,
            table: &mut self.table,
        }
    }
}

impl WasiWebcryptoView for Ctx {
    fn webcrypto(&mut self) -> WasiWebcryptoCtxView<'_> {
        WasiWebcryptoCtxView {
            ctx: &mut self.webcrypto,
            table: &mut self.table,
        }
    }
}

impl WasiWebsocketView for Ctx {
    fn websocket(&mut self) -> WasiWebsocketCtxView<'_> {
        WasiWebsocketCtxView {
            ctx: &mut self.websocket,
            table: &mut self.table,
        }
    }
}

/// The component model with component-model async enabled (the guests'
/// imports and their `run` exports use the async ABI).
pub fn engine() -> Result<Engine> {
    let mut config = Config::new();
    config.wasm_component_model(true);
    config.wasm_component_model_async(true);
    Engine::new(&config)
}

/// The WebRTC context, honoring the demo hosts' `WEBRTC_INCLUDE_LOOPBACK`
/// convention (same-host peers need loopback ICE candidates to pair).
pub fn webrtc_ctx() -> WebrtcCtx {
    let mut ctx = WebrtcCtx::new();
    if std::env::var_os("WEBRTC_INCLUDE_LOOPBACK").is_some() {
        ctx.set_setting_engine_hook(|engine| engine.with_include_loopback_candidate(true));
    }
    ctx
}

/// A linker carrying WASI (p2 for the guests' `std`, p3 for their
/// `wasi:clocks@0.3` timers) and all three sibling host surfaces.
pub fn linker(engine: &Engine) -> Result<Linker<Ctx>> {
    let mut linker: Linker<Ctx> = Linker::new(engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
    wasmtime_wasi::p3::add_to_linker(&mut linker)?;
    webrtc_host::add_to_linker(&mut linker)?;
    polymorph_webcrypto_wasmtime::add_to_linker(&mut linker)?;
    wasmtime_websocket::add_to_linker(&mut linker)?;
    Ok(linker)
}

/// A store with stdio and environment inherited, as every driver runs
/// them.
pub fn store(engine: &Engine) -> Store<Ctx> {
    store_inner(engine, false)
}

/// As [`store`], plus the host network: the endpoint demo's UDP direct
/// path binds and dials through `wasi:sockets`.
pub fn store_with_network(engine: &Engine) -> Store<Ctx> {
    store_inner(engine, true)
}

fn store_inner(engine: &Engine, network: bool) -> Store<Ctx> {
    let mut wasi = WasiCtx::builder();
    wasi.inherit_stdio().inherit_env();
    if network {
        // wasmtime-wasi 48 defaults AllowedNetworkUses to all-off
        // (inherit_network only lifts the address check); the direct
        // path opens wasi:sockets UDP.
        wasi.inherit_network().allow_udp(true);
    }
    Store::new(
        engine,
        Ctx {
            wasi: wasi.build(),
            webrtc: webrtc_ctx(),
            webcrypto: WasiWebcryptoCtx::new(),
            websocket: WasiWebsocketCtx::new(),
            table: ResourceTable::new(),
        },
    )
}
