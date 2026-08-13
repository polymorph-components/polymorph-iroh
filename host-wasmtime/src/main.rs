//! `iroh-hosts`: the Wasmtime host drivers as one multi-call binary.
//!
//! Each subcommand embeds the same stack — wasmtime, the sibling host
//! modules, tokio — and they differ only in driver logic, so one
//! binary means one link instead of three (the links dominate the
//! host build; see PR #63/#66 for the measurements this shape rests
//! on):
//!
//!   * `spike` — the QUIC-over-data-channel spike guest (`src/spike.rs`),
//!   * `endpoint-demo` — the composed endpoint+demo component
//!     (`src/endpoint_demo.rs`),
//!   * `exec-model` — the execution-model probe guest
//!     (`src/exec_model.rs`).
//!
//! `iroh-peer` stays a separate binary: it embeds upstream iroh, not
//! wasmtime, and merging unrelated dependency graphs would only grow
//! the link.

use clap::Parser;

mod endpoint_demo;
mod exec_model;
mod spike;

#[derive(Parser)]
#[command(
    name = "iroh-hosts",
    about = "Wasmtime host drivers for the polymorph:iroh components"
)]
enum Command {
    /// Run one peer of the QUIC-over-data-channel spike demo.
    Spike(spike::Args),
    /// Run one peer of the endpoint echo demo (the wac-composed component).
    EndpointDemo(endpoint_demo::Args),
    /// Run the execution-model probes.
    ExecModel(exec_model::Args),
}

#[tokio::main]
async fn main() -> wasmtime::Result<()> {
    let _ = env_logger::try_init();
    match Command::parse() {
        Command::Spike(args) => spike::run(args).await,
        Command::EndpointDemo(args) => endpoint_demo::run(args).await,
        Command::ExecModel(args) => exec_model::run(args).await,
    }
}
