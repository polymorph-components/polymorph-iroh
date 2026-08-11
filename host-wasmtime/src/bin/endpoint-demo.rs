//! `iroh-endpoint-demo` host: runs one peer of the endpoint echo demo —
//! the `wac`-composed endpoint+demo component — under Wasmtime.
//!
//! ```sh
//! iroh-relay --dev &   # serves ws on 127.0.0.1:3340
//! endpoint-demo <composed.wasm> --role server --relay http://127.0.0.1:3340 &
//! endpoint-demo <composed.wasm> --role client --relay http://127.0.0.1:3340 --peer <endpoint-id>
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

struct Cli {
    component: String,
    role: DemoRole,
    relay: String,
    peer: Option<String>,
    alpn: Option<String>,
    udp_bind: Option<String>,
    direct: Option<String>,
    webrtc: bool,
    peer_relay: Option<String>,
    payload_bytes: Option<u64>,
    datagram: bool,
    inject_identity: bool,
    identity_negative: bool,
    message: String,
}

fn usage() -> wasmtime::Error {
    wasmtime::Error::msg(
        "usage: endpoint-demo <composed.wasm> --role <client|server> \
         --relay <relay-url> [--peer <endpoint-id-hex>] [--alpn A] \
         [--udp-bind <ip:port>] [--direct <ip:port>] [--webrtc] \
         [--peer-relay <relay-url>] [--payload-bytes N] [--datagram] \
         [--inject-identity] [--identity-negative] [--message M]",
    )
}

fn parse_args() -> Result<Cli> {
    let mut args = std::env::args().skip(1);
    let component = args.next().ok_or_else(usage)?;
    let mut role = None;
    let mut relay = None;
    let mut peer = None;
    let mut alpn = None;
    let mut udp_bind = None;
    let mut direct = None;
    let mut webrtc = false;
    let mut peer_relay = None;
    let mut payload_bytes = None;
    let mut datagram = false;
    let mut inject_identity = false;
    let mut identity_negative = false;
    let mut message = "hello through the endpoint surface".to_string();
    while let Some(flag) = args.next() {
        let mut value = || args.next().ok_or_else(usage);
        match flag.as_str() {
            "--role" => {
                role = Some(match value()?.as_str() {
                    "client" => DemoRole::Client,
                    "server" => DemoRole::Server,
                    _ => return Err(usage()),
                })
            }
            "--relay" => relay = Some(value()?),
            "--peer" => peer = Some(value()?),
            "--alpn" => alpn = Some(value()?),
            "--udp-bind" => udp_bind = Some(value()?),
            "--direct" => direct = Some(value()?),
            "--webrtc" => webrtc = true,
            "--peer-relay" => peer_relay = Some(value()?),
            "--payload-bytes" => {
                payload_bytes = Some(value()?.parse::<u64>().map_err(|_| usage())?)
            }
            "--datagram" => datagram = true,
            "--inject-identity" => inject_identity = true,
            "--identity-negative" => identity_negative = true,
            "--message" => message = value()?,
            _ => return Err(usage()),
        }
    }
    Ok(Cli {
        component,
        role: role.ok_or_else(usage)?,
        relay: relay.ok_or_else(usage)?,
        peer,
        alpn,
        udp_bind,
        direct,
        webrtc,
        peer_relay,
        payload_bytes,
        datagram,
        inject_identity,
        identity_negative,
        message,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = env_logger::try_init();
    let cli = parse_args()?;

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

    let role = cli.role;
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
        inject_identity: cli.inject_identity,
        identity_negative: cli.identity_negative,
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
