//! `iroh-endpoint-demo` host: runs one peer of the endpoint echo demo —
//! the `wac`-composed endpoint+demo component — under Wasmtime.
//!
//! ```sh
//! iroh-relay --dev &   # serves ws on 127.0.0.1:3340
//! endpoint-demo <composed.wasm> --role server --relay http://127.0.0.1:3340 &
//! endpoint-demo <composed.wasm> --role client --relay http://127.0.0.1:3340 --peer <endpoint-id>
//! ```

use iroh_spike_host_wasmtime::{engine, linker, store_with_network, Ctx};
use wasmtime::component::Accessor;
use wasmtime::component::Component;
use wasmtime::Result;

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
    datagram_ceiling: Option<u32>,
    inject_identity: bool,
    identity_negative: bool,
    stream_negative: bool,
    backlog_negative: bool,
    message: String,
}

fn usage() -> wasmtime::Error {
    wasmtime::Error::msg(
        "usage: endpoint-demo <composed.wasm> --role <client|server> \
         --relay <relay-url> [--peer <endpoint-id-hex>] [--alpn A] \
         [--udp-bind <ip:port>] [--direct <ip:port>] [--webrtc] \
         [--peer-relay <relay-url>] [--payload-bytes N] [--datagram] \
         [--datagram-ceiling BYTES] [--inject-identity] \
         [--identity-negative] [--stream-negative] [--backlog-negative] \
         [--message M]",
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
    let mut datagram_ceiling = None;
    let mut inject_identity = false;
    let mut identity_negative = false;
    let mut stream_negative = false;
    let mut backlog_negative = false;
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
            "--datagram-ceiling" => {
                datagram_ceiling = Some(value()?.parse::<u32>().map_err(|_| usage())?)
            }
            "--inject-identity" => inject_identity = true,
            "--identity-negative" => identity_negative = true,
            "--stream-negative" => stream_negative = true,
            "--backlog-negative" => backlog_negative = true,
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
        datagram_ceiling,
        inject_identity,
        identity_negative,
        stream_negative,
        backlog_negative,
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
    // The UDP direct path binds and dials through `wasi:sockets`; this
    // demo driver grants it the host network wholesale.
    let mut store = store_with_network(&engine);
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
