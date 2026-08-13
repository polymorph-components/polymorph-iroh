//! Execution-model probe driver: runs the `exec-model` experiment guest
//! under Wasmtime and prints one `PROBE <name>: <outcome>` line per probe.
//! See `experiments/exec-model/wit/world.wit`.

use std::pin::Pin;
use std::sync::mpsc;
use std::task::{Context, Poll};

use iroh_spike_host_wasmtime::{engine, linker, store, Ctx};
use wasmtime::component::Component;
use wasmtime::component::{Accessor, Source, StreamConsumer, StreamReader, StreamResult};
use wasmtime::{Result, StoreContextMut};

mod bindings {
    wasmtime::component::bindgen!({
        path: "../experiments/exec-model/wit",
        world: "exec-model",
        imports: {
            default: async | store | trappable,
        },
        exports: {
            default: async,
        },
    });
}

/// Counts bytes and stops accepting (reports `Dropped`) once `limit` is
/// reached — the "reader walks away mid-stream" case. Reports the final
/// count when the stream ends either way.
struct CountThenDrop {
    count: u64,
    limit: u64,
    done_tx: Option<mpsc::Sender<u64>>,
}

impl CountThenDrop {
    fn finish(&mut self) {
        if let Some(tx) = self.done_tx.take() {
            let _ = tx.send(self.count);
        }
    }
}

impl<D: Send + 'static> StreamConsumer<D> for CountThenDrop {
    type Item = u8;

    fn poll_consume(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        mut store: StoreContextMut<D>,
        mut source: Source<'_, u8>,
        finish: bool,
    ) -> Poll<Result<StreamResult>> {
        let this = self.get_mut();
        let available = source.remaining(&mut store);
        if available > 0 {
            let mut chunk = Vec::with_capacity(available);
            source.read(&mut store, &mut chunk)?;
            this.count += chunk.len() as u64;
            if this.count >= this.limit {
                this.finish();
                return Poll::Ready(Ok(StreamResult::Dropped));
            }
            return Poll::Ready(Ok(StreamResult::Completed));
        }
        if finish {
            this.finish();
            Poll::Ready(Ok(StreamResult::Cancelled))
        } else {
            Poll::Pending
        }
    }
}

impl Drop for CountThenDrop {
    fn drop(&mut self) {
        self.finish();
    }
}

fn print_probe(name: &str, result: &std::result::Result<String, String>) {
    match result {
        Ok(detail) => println!("PROBE {name}: ok: {detail}"),
        Err(err) => println!("PROBE {name}: FAILED: {err}"),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "target/wasm32-wasip2/release/iroh_exec_model_guest.wasm".into());

    let engine = engine()?;
    let component = Component::from_file(&engine, &path)?;
    let linker = linker(&engine)?;
    let mut store = store(&engine);
    let probe = bindings::ExecModel::instantiate_async(&mut store, &component, &linker).await?;

    store
        .run_concurrent(async move |accessor: &Accessor<Ctx>| -> Result<()> {
            let guest = probe.polymorph_iroh_exec_model_probe();

            let result = guest.call_blockon_in_spawn(accessor).await?;
            print_probe("blockon-in-spawn", &result);

            guest
                .call_start_pump(accessor)
                .await?
                .map_err(wasmtime::Error::msg)?;
            let result = guest.call_poll_pump(accessor).await?;
            print_probe("blockon-in-detached-pump", &result);

            // Guest-produced stream, read to completion.
            let reader = guest.call_open_stream(accessor, 5000, 1000).await?;
            let (tx, rx) = mpsc::channel();
            accessor.with(|access| {
                reader.pipe(
                    access,
                    CountThenDrop {
                        count: 0,
                        limit: u64::MAX,
                        done_tx: Some(tx),
                    },
                )
            })?;
            let outcome = guest.call_stream_outcome(accessor).await?;
            let count = rx.try_recv().map(|n| n.to_string()).unwrap_or_default();
            print_probe(
                "export-stream-complete",
                &outcome.map(|d| format!("host read {count}, guest: {d}")),
            );

            // Guest-produced stream, reader stops mid-stream.
            let reader = guest.call_open_stream(accessor, 100_000, 1000).await?;
            let (tx, rx) = mpsc::channel();
            accessor.with(|access| {
                reader.pipe(
                    access,
                    CountThenDrop {
                        count: 0,
                        limit: 2500,
                        done_tx: Some(tx),
                    },
                )
            })?;
            let outcome = guest.call_stream_outcome(accessor).await?;
            let count = rx.try_recv().map(|n| n.to_string()).unwrap_or_default();
            print_probe(
                "export-stream-reader-drop",
                &outcome.map(|d| format!("host read {count}, guest: {d}")),
            );

            // Host-produced stream consumed by the guest.
            let reader = accessor.with(|access| StreamReader::new(access, vec![0x33u8; 12_345]))?;
            let counted = guest.call_sink_stream(accessor, reader).await?;
            print_probe(
                "import-stream-sink",
                &counted.map(|n| format!("guest counted {n} bytes")),
            );

            Ok(())
        })
        .await??;

    println!("exec-model probes complete");
    Ok(())
}
