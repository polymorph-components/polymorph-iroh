# The single entry point for building and checking this repository; run
# `just` to list recipes. CI job bodies live in the gha module
# (`.github/justfile`), so `just ci` is exactly CI.

# GitHub Actions plumbing: CI job entry points.
mod gha '.github'

# List the available recipes.
default:
    @just --list

# One-shot dependency setup (sibling + iroh checkouts, npm installs).
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

# Transpile the guest components for the Node host.
transpile: build-components
    cd host-jco && npm run transpile
    cd host-jco && npm run transpile-endpoint

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

# The execution-model probes on both hosts.
probes: build build-components
    cargo build -p iroh-exec-model-guest --target wasm32-wasip2 --release
    target/release/exec-model target/wasm32-wasip2/release/iroh_exec_model_guest.wasm
    cd host-jco && npm run transpile-exec && timeout 120 node --experimental-wasm-jspi src/run-exec.mjs

# The cross-host pairing matrix: every demo pairing asserted in one run.
matrix: build transpile relay-build
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

# The measured-claims gate: per-wire latency/throughput medians and the
# webcrypto boundary call counts, asserted against budgets (issue #4).
bench: build transpile relay-build
    ./scripts/bench.sh

# The endpoint against n0's production relays over wss (issue #2).
# Internet-dependent by nature, so manual: not part of `ci`.
interop-prod: build
    ./scripts/interop-prod.sh

# The synthetic-UDP wake probes (issue #14): a tokio reactor inside a
# jco/JSPI wasip2 component, woken from JS through a synthetic
# wasi:sockets shim — once host-side, once through a wac-composed
# guest-side virtualization component over a generic event source.
# Research probes attached to the issue, so manual: not part of `ci`.
# Needs the jco fork from setup.sh.
udp-wake:
    cd experiments/udp-wake/guest && cargo build --release
    cd experiments/udp-wake/virt && cargo build --release
    cd experiments/udp-wake && wac plug guest/target/wasm32-wasip2/release/iroh-udp-wake-guest.wasm --plug virt/target/wasm32-wasip2/release/iroh_udp_wake_virt.wasm -o composed.wasm
    cd experiments/udp-wake/host && npm install --no-audit --no-fund && npm run transpile && timeout 120 npm start && timeout 120 npm run start-composed

# The fast pre-commit checks.
check: fmt-check clippy validate-wit test

# The exact set of checks CI runs: the CI job runs exactly one gha:: job
# recipe.
ci: (gha::checks)
