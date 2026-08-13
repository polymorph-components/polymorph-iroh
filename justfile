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
    cargo build -p iroh-spike-host-wasmtime -p iroh-peer --profile host

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
    target/host/exec-model target/wasm32-wasip2/release/iroh_exec_model_guest.wasm

# The cross-host pairing matrix: every demo pairing asserted in one run.
matrix: build relay-build
    ./scripts/matrix.sh

# The deltic host's module graph + the node-datachannel addon (whose
# install script needs an explicit grant). Idempotent.
deltic-setup:
    cd host-deltic && deno install --frozen --allow-scripts=npm:node-datachannel

# The deltic host's unit tests: the `wasi:sockets` UDP provider's codec,
# state machine, and error contract (host-deltic/src/sockets_test.ts).
deltic-test: deltic-setup
    deno test -A --config host-deltic/deno.json --frozen host-deltic/src/

# The endpoint exam on the deltic host: the endpoint component
# runtime-linked under stock Deno — bind + identity, relay echo, WebRTC
# upgrade, the issue #10 concurrency rows, the direct UDP path, teardown.
# See host-deltic/README.md.
exam-deltic: build-components relay-build deltic-setup
    #!/usr/bin/env bash
    set -euo pipefail
    # One deltic version repo-wide (host-deltic/README.md "The pin"): the
    # exam is the natural fail-loud point, replacing the retired
    # fetch-translator gate. Every jsr:@deltic/* pin in both configs must
    # name the SAME prerelease — a translator/runtime split is exactly the
    # plan-format skew (or double-runtime WitError identity break) the
    # packaged translator exists to rule out.
    v=$(grep -ho 'jsr:@deltic/[a-z-]*@[^/"]*' host-deltic/deno.json \
        experiments/iroh-relay-ws/host/deno.json | sed 's/.*@//' | sort -u)
    if [ "$(printf '%s\n' "$v" | wc -l)" != 1 ]; then
        echo "deltic pin drift across deno.jsons: $v" >&2
        exit 1
    fi
    # ...and the RESOLVED graph must agree: one embedder instance, no raw
    # URLs (a sibling .deps module's own config can silently split module
    # identity in a way no config grep catches; see the gate script).
    deno info --json --config host-deltic/deno.json host-deltic/src/run-endpoint.ts \
        | deno run scripts/deltic-identity-gate.ts
    timeout 600 deno run -A --config host-deltic/deno.json --frozen \
        host-deltic/src/run-endpoint.ts

# The measured-claims gate: per-wire latency/throughput medians,
# asserted against budgets (issue #4).
bench: build relay-build
    ./scripts/bench.sh

# The endpoint against n0's production relays over wss (issue #2).
# Internet-dependent by nature, so manual: not part of `ci`.
interop-prod: build
    ./scripts/interop-prod.sh

# The upstream-iroh-over-relay spike (issue #14): the unmodified iroh
# crate (upstream main + the wasi-enablement patch branches, from the
# lann/iroh and lann/net-tools polymorph-iroh branches) as a wasip2
# component, runtime-linked under deltic on stock Deno — relay-only
# bootstrap over the polymorph-websocket sibling's deltic module, then
# live migration onto a WebRTC data channel through the synthetic-address
# overlay (issue #26). Research probe attached to the issue, so manual:
# not part of `ci`. Needs the sibling checkouts from setup.sh.
iroh-relay-ws: relay-build
    cd experiments/iroh-relay-ws/guest && cargo build --release
    cd experiments/iroh-relay-ws/host && deno install --frozen --allow-scripts=npm:node-datachannel
    ./experiments/iroh-relay-ws/run.sh

# The fast pre-commit checks.
check: fmt-check clippy validate-wit test

# The exact set of checks CI runs: the CI job runs exactly one gha:: job
# recipe.
ci: (gha::checks)
