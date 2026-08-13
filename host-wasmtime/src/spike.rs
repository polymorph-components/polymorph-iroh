//! The `spike` subcommand: runs one peer of the QUIC-over-data-channel
//! demo under Wasmtime.
//!
//! It loads the `iroh-spike` component (one role of a demo run) and
//! provisions its imports:
//!
//!   * `wasi:*@0.2` via `wasmtime_wasi::p2` (the guest's Rust `std` lowers to
//!     these) and `wasi:clocks@0.3` via `wasmtime_wasi::p3` (the guest's
//!     endpoint timer),
//!   * the `connections`/`types` surface via [`wasmtime_webrtc_datachannels`]
//!     (a real `webrtc-rs` peer connection),
//!   * the `polymorph:websocket` surface via [`wasmtime_websocket`]
//!     (tokio-tungstenite; carries the guest's relay signaling), and
//!   * the `polymorph:webcrypto` surface via [`polymorph_webcrypto_wasmtime`]
//!     (RustCrypto).
//!
//! Run two instances — a server, then a client handed the server's
//! printed endpoint ID — against the same stock `iroh-relay` server:
//!
//! ```sh
//! iroh-relay --dev &   # serves ws on 127.0.0.1:3340
//! iroh-hosts spike <component.wasm> --role server --server http://127.0.0.1:3340 &
//! iroh-hosts spike <component.wasm> --role client --server http://127.0.0.1:3340 --peer <endpoint-id>
//! ```

use polymorph_webcrypto_wasmtime::{WasiWebcryptoCtx, WasiWebcryptoCtxView, WasiWebcryptoView};
use wasmtime::component::{Accessor, Component, HasData, Linker, ResourceTable};
use wasmtime::{Config, Engine, Result, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};
use wasmtime_webrtc_datachannels::{self as webrtc_host, WebrtcCtx, WebrtcCtxView, WebrtcView};
use wasmtime_websocket::{WasiWebsocketCtx, WasiWebsocketCtxView, WasiWebsocketView};

mod bindings {
    wasmtime::component::bindgen!({
        path: "../guest/wit",
        world: "iroh-spike",
        imports: {
            default: async | store | trappable,
        },
        exports: {
            default: async,
        },
    });
}

use bindings::exports::polymorph::iroh_spike::demo::{
    Role as DemoRole, RunConfig, Transport as DemoTransport,
};

struct Ctx {
    wasi: WasiCtx,
    webrtc: WebrtcCtx,
    webcrypto: WasiWebcryptoCtx,
    websocket: WasiWebsocketCtx,
    table: ResourceTable,
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

/// The component model with component-model async enabled (the guest's
/// imports and its `run` export use the async ABI).
fn engine() -> Result<Engine> {
    let mut config = Config::new();
    config.wasm_component_model(true);
    config.wasm_component_model_async(true);
    Engine::new(&config)
}

/// The WebRTC context, honoring the demo hosts' `WEBRTC_INCLUDE_LOOPBACK`
/// convention (same-host peers need loopback ICE candidates to pair).
fn webrtc_ctx() -> WebrtcCtx {
    let mut ctx = WebrtcCtx::new();
    if std::env::var_os("WEBRTC_INCLUDE_LOOPBACK").is_some() {
        ctx.set_setting_engine_hook(|engine| {
            engine.set_include_loopback_candidate(true);
        });
    }
    ctx
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum Role {
    Client,
    Server,
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum Transport {
    Webrtc,
    Relay,
}

#[derive(clap::Args)]
pub struct Args {
    /// Path to the iroh-spike component.
    component: String,
    /// Which side this process drives.
    #[arg(long, value_enum)]
    role: Role,
    /// The iroh relay server's base URL.
    #[arg(long)]
    server: String,
    /// The server peer's endpoint ID (hex). Required on the client.
    #[arg(long)]
    peer: Option<String>,
    /// The wire the demo runs on.
    #[arg(long, value_enum, default_value = "webrtc")]
    transport: Transport,
    /// The application message the client sends.
    #[arg(long, default_value = "hello over QUIC over a data channel")]
    message: String,
}

pub async fn run(cli: Args) -> Result<()> {
    let engine = engine()?;
    let component = Component::from_file(&engine, &cli.component)?;
    let mut linker: Linker<Ctx> = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
    // Serves the guest's `wasi:clocks@0.3` timer alongside the p3 surface.
    wasmtime_wasi::p3::add_to_linker(&mut linker)?;
    webrtc_host::add_to_linker(&mut linker)?;
    polymorph_webcrypto_wasmtime::add_to_linker(&mut linker)?;
    wasmtime_websocket::add_to_linker(&mut linker)?;

    let mut wasi = WasiCtx::builder();
    wasi.inherit_stdio().inherit_env();
    let mut store = Store::new(
        &engine,
        Ctx {
            wasi: wasi.build(),
            webrtc: webrtc_ctx(),
            webcrypto: WasiWebcryptoCtx::new(),
            websocket: WasiWebsocketCtx::new(),
            table: ResourceTable::new(),
        },
    );
    let demo = bindings::IrohSpike::instantiate_async(&mut store, &component, &linker).await?;

    let role = match cli.role {
        Role::Client => DemoRole::Client,
        Role::Server => DemoRole::Server,
    };
    let config = RunConfig {
        server: cli.server,
        role,
        transport: match cli.transport {
            Transport::Webrtc => DemoTransport::Webrtc,
            Transport::Relay => DemoTransport::Relay,
        },
        peer: cli.peer,
        message: cli.message,
    };
    let report = store
        .run_concurrent(async move |accessor: &Accessor<Ctx>| {
            demo.polymorph_iroh_spike_demo()
                .call_run(accessor, config)
                .await
        })
        .await??;

    match report {
        Ok(report) => {
            let role = match role {
                DemoRole::Client => "client",
                DemoRole::Server => "server",
            };
            println!(
                "iroh-spike ({role}): endpoint={} peer={} handshake_ms={} roundtrip_ms={} received={:?}",
                report.endpoint_id,
                report.peer_id,
                report.handshake_ms,
                report.roundtrip_ms,
                report.received
            );
            println!("OK: {role} finished.");
        }
        Err(err) => {
            return Err(wasmtime::Error::msg(format!(
                "iroh-spike returned error: {err}"
            )))
        }
    }
    Ok(())
}
