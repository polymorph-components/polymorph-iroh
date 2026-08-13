//! The `endpoint-demo` subcommand: runs one peer of the endpoint echo
//! demo — the `wac`-composed endpoint+demo component — under Wasmtime.
//!
//! ```sh
//! iroh-relay --dev &   # serves ws on 127.0.0.1:3340
//! iroh-hosts endpoint-demo <composed.wasm> --role server --relay http://127.0.0.1:3340 &
//! iroh-hosts endpoint-demo <composed.wasm> --role client --relay http://127.0.0.1:3340 --peer <endpoint-id>
//! ```

use polymorph_webcrypto_wasmtime::{WasiWebcryptoCtx, WasiWebcryptoCtxView, WasiWebcryptoView};
use wasmtime::component::{Accessor, Component, HasData, Linker, ResourceTable};
use wasmtime::{Config, Engine, Result, Store};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};
use wasmtime_webrtc_datachannels::{self as webrtc_host, WebrtcCtx, WebrtcCtxView, WebrtcView};
use wasmtime_websocket::{WasiWebsocketCtx, WasiWebsocketCtxView, WasiWebsocketView};

mod bindings {
    wasmtime::component::bindgen!({
        path: "../endpoint-demo/wit",
        world: "iroh-demo",
        imports: {
            default: async | store | trappable,
        },
        exports: {
            default: async,
        },
    });
}

use bindings::exports::polymorph::iroh_demo::demo::{Role as DemoRole, RunConfig};

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

#[derive(Clone, Copy, clap::ValueEnum)]
enum Role {
    Client,
    Server,
}

#[derive(clap::Args)]
pub struct Args {
    /// Path to the wac-composed endpoint+demo component.
    component: String,
    /// Which side this process drives.
    #[arg(long, value_enum)]
    role: Role,
    /// This process's home relay base URL.
    #[arg(long)]
    relay: String,
    /// The server peer's endpoint ID (hex). Required on the client.
    #[arg(long)]
    peer: Option<String>,
    /// The ALPN the client offers, overriding the demo's own (a
    /// failure-path probe knob).
    #[arg(long)]
    alpn: Option<String>,
    /// The `ip:port` to bind the endpoint's UDP socket to.
    #[arg(long)]
    udp_bind: Option<String>,
    /// A direct `ip:port` for the server peer, preferred over the relay.
    #[arg(long)]
    direct: Option<String>,
    /// Enables the WebRTC wire.
    #[arg(long)]
    webrtc: bool,
    /// The server peer's relay URL, when it differs from `--relay`.
    #[arg(long)]
    peer_relay: Option<String>,
    /// Replace the client's message with this many zero bytes (bulk).
    #[arg(long)]
    payload_bytes: Option<u64>,
    /// Also exchange one datagram echo after the stream echo.
    #[arg(long)]
    datagram: bool,
    /// With --datagram: wait for max-datagram-size to reach this many
    /// bytes, then exchange a datagram of exactly this size.
    #[arg(long)]
    datagram_ceiling: Option<u32>,
    /// Construct the identity from webcrypto key handles
    /// (identity-from-keys) instead of identity-generate.
    #[arg(long)]
    inject_identity: bool,
    /// Probe the identity constructor's failure paths instead of the echo.
    #[arg(long)]
    identity_negative: bool,
    /// Probe the stream and connect lifecycles instead of the echo.
    #[arg(long)]
    stream_negative: bool,
    /// Probe the accept backlog instead of the echo.
    #[arg(long)]
    backlog_negative: bool,
    /// The application message the client sends.
    #[arg(long, default_value = "hello through the endpoint surface")]
    message: String,
}

pub async fn run(cli: Args) -> Result<()> {
    let mut config = Config::new();
    config.wasm_component_model(true);
    config.wasm_component_model_async(true);
    let engine = Engine::new(&config)?;
    let component = Component::from_file(&engine, &cli.component)?;
    let mut linker: Linker<Ctx> = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
    wasmtime_wasi::p3::add_to_linker(&mut linker)?;
    webrtc_host::add_to_linker(&mut linker)?;
    polymorph_webcrypto_wasmtime::add_to_linker(&mut linker)?;
    wasmtime_websocket::add_to_linker(&mut linker)?;

    let mut wasi = WasiCtx::builder();
    // The UDP direct path binds and dials through `wasi:sockets`; this
    // demo driver grants it the host network wholesale.
    wasi.inherit_stdio().inherit_env().inherit_network();
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
    let demo = bindings::IrohDemo::instantiate_async(&mut store, &component, &linker).await?;

    let role = match cli.role {
        Role::Client => DemoRole::Client,
        Role::Server => DemoRole::Server,
    };
    let config = RunConfig {
        relay_url: cli.relay,
        role,
        peer: cli.peer,
        alpn: cli.alpn,
        udp_bind: cli.udp_bind,
        direct: cli.direct,
        webrtc: cli.webrtc,
        peer_relay: cli.peer_relay,
        payload_bytes: cli.payload_bytes,
        datagram: cli.datagram,
        datagram_ceiling: cli.datagram_ceiling,
        inject_identity: cli.inject_identity,
        identity_negative: cli.identity_negative,
        stream_negative: cli.stream_negative,
        backlog_negative: cli.backlog_negative,
        message: cli.message,
    };
    let report = store
        .run_concurrent(async move |accessor: &Accessor<Ctx>| {
            demo.polymorph_iroh_demo_demo()
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
                "iroh-demo ({role}): endpoint={} peer={} path={} handshake_ms={} roundtrip_ms={} received={:?} datagram={:?}",
                report.endpoint_id,
                report.peer_id,
                report.path,
                report.handshake_ms,
                report.roundtrip_ms,
                report.received,
                report.datagram
            );
            println!("OK: {role} finished.");
        }
        Err(err) => {
            return Err(wasmtime::Error::msg(format!(
                "iroh-demo returned error: {err}"
            )))
        }
    }
    Ok(())
}

/// The WebRTC context, honoring the demo hosts' `WEBRTC_INCLUDE_LOOPBACK`
/// convention.
fn webrtc_ctx() -> WebrtcCtx {
    let mut ctx = WebrtcCtx::new();
    if std::env::var_os("WEBRTC_INCLUDE_LOOPBACK").is_some() {
        ctx.set_setting_engine_hook(|engine| {
            engine.set_include_loopback_candidate(true);
        });
    }
    ctx
}
