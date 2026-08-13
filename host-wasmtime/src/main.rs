//! `iroh-spike-host`: runs one peer of the QUIC-over-data-channel demo under
//! Wasmtime.
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
//! iroh-spike-host <component.wasm> --role server --server http://127.0.0.1:3340 &
//! iroh-spike-host <component.wasm> --role client --server http://127.0.0.1:3340 --peer <endpoint-id>
//! ```

use iroh_spike_host_wasmtime::{engine, linker, store, Ctx};
use wasmtime::component::{Accessor, Component};
use wasmtime::Result;

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

struct Cli {
    component: String,
    role: DemoRole,
    server: String,
    peer: Option<String>,
    transport: DemoTransport,
    message: String,
}

fn usage() -> wasmtime::Error {
    wasmtime::Error::msg(
        "usage: iroh-spike-host <component.wasm> --role <client|server> \
         --server <relay-url> [--peer <endpoint-id-hex>] \
         [--transport <webrtc|relay>] [--message M]",
    )
}

fn parse_args() -> Result<Cli> {
    let mut args = std::env::args().skip(1);
    let component = args.next().ok_or_else(usage)?;
    let mut role = None;
    let mut server = None;
    let mut peer = None;
    let mut transport = DemoTransport::Webrtc;
    let mut message = "hello over QUIC over a data channel".to_string();
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
            "--server" => server = Some(value()?),
            "--peer" => peer = Some(value()?),
            "--transport" => {
                transport = match value()?.as_str() {
                    "webrtc" => DemoTransport::Webrtc,
                    "relay" => DemoTransport::Relay,
                    _ => return Err(usage()),
                }
            }
            "--message" => message = value()?,
            _ => return Err(usage()),
        }
    }
    Ok(Cli {
        component,
        role: role.ok_or_else(usage)?,
        server: server.ok_or_else(usage)?,
        peer,
        transport,
        message,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = env_logger::try_init();
    let cli = parse_args()?;

    let engine = engine()?;
    let component = Component::from_file(&engine, &cli.component)?;
    let linker = linker(&engine)?;
    let mut store = store(&engine);
    let demo = bindings::IrohSpike::instantiate_async(&mut store, &component, &linker).await?;

    let role = cli.role;
    let config = RunConfig {
        server: cli.server,
        role,
        transport: cli.transport,
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
