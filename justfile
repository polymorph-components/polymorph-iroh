# The single entry point for building and checking this repository; run
# `just` to list recipes. CI job bodies live in the gha module
# (`.github/justfile`), so `just ci` is exactly CI.

# GitHub Actions plumbing: CI job entry points.
mod gha '.github'

# List the available recipes.
default:
    @just --list

# One-shot dependency setup (sibling + iroh checkouts).
setup:
    ./scripts/setup.sh

# Build every guest component and compose the endpoint demo.
build-components:
    cargo build -p iroh-spike-guest -p iroh-endpoint -p iroh-endpoint-demo -p iroh-exec-model-guest --target wasm32-wasip2 --release
    mkdir -p target/components
    wac plug target/wasm32-wasip2/release/iroh_endpoint_demo.wasm --plug target/wasm32-wasip2/release/iroh_endpoint.wasm -o target/components/iroh-demo.wasm

# Build the Wasmtime host binaries and the native interop peer.
build-hosts:
    cargo build -p iroh-spike-host-wasmtime -p iroh-peer --release

# Build the stock upstream relay server (used by the matrix and demos).
relay-build:
    cd .deps/iroh && cargo build --release -p iroh-relay --features server --bin iroh-relay

build: build-components build-hosts

# Native tests: the crypto/framing known answers.
test:
    cargo test -p iroh-endpoint-core -p iroh-spike-guest

fmt-check:
    cargo fmt --all --check

clippy:
    cargo clippy --all-targets
    cargo clippy -p iroh-peer --all-targets
    cargo clippy -p iroh-spike-guest -p iroh-endpoint -p iroh-endpoint-demo -p iroh-exec-model-guest --target wasm32-wasip2

validate-wit:
    wasm-tools component wit wit/ > /dev/null
    wasm-tools component wit core/wit/ > /dev/null
    wasm-tools component wit guest/wit/ > /dev/null
    wasm-tools component wit endpoint-demo/wit/ > /dev/null
    wasm-tools component wit experiments/exec-model/wit/ > /dev/null

# The execution-model probes on the Wasmtime host.
probes: build build-components
    cargo build -p iroh-exec-model-guest --target wasm32-wasip2 --release
    target/release/exec-model target/wasm32-wasip2/release/iroh_exec_model_guest.wasm

# The cross-host pairing matrix: every demo pairing asserted in one run.
matrix: build relay-build
    ./scripts/matrix.sh

# The deltic host's module graph + the node-datachannel addon (whose
# install script needs an explicit grant). Idempotent.
deltic-setup:
    cd host-deltic && deno install --frozen --allow-scripts=npm:node-datachannel

# The endpoint exam on the deltic host: the endpoint component
# runtime-linked under stock Deno — bind + identity, relay echo, WebRTC
# upgrade, the issue #10 concurrency rows, teardown. See
# host-deltic/README.md.
exam-deltic: build-components relay-build deltic-setup
    #!/usr/bin/env bash
    set -euo pipefail
    shim=$(deno run --config host-deltic/deno.json --frozen \
        --allow-read=. --allow-write=target/deltic \
        --allow-net=github.com,objects.githubusercontent.com,release-assets.githubusercontent.com \
        host-deltic/fetch-translator.ts)
    DELTIC_TRANSLATOR="$shim" timeout 600 deno run -A --config host-deltic/deno.json --frozen \
        host-deltic/src/run-endpoint.ts

# The measured-claims gate: per-wire latency/throughput medians,
# asserted against budgets (issue #4).
bench: build relay-build
    ./scripts/bench.sh

# The endpoint against n0's production relays over wss (issue #2).
# Internet-dependent by nature, so manual: not part of `ci`.
interop-prod: build
    ./scripts/interop-prod.sh

# The fast pre-commit checks.
check: fmt-check clippy validate-wit test

# The exact set of checks CI runs: the CI job runs exactly one gha:: job
# recipe.
ci: (gha::checks)
