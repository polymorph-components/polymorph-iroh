# The single entry point for building and checking this repository; run
# `just` to list recipes. CI job bodies live in the gha module
# (`.github/justfile`), so `just ci` is exactly CI.

# GitHub Actions plumbing: CI job entry points.
mod gha '.github'

# List the available recipes.
default:
    @just --list

# One-shot dependency setup (pinned tools + the iroh-relay binary).
setup:
    ./scripts/setup.sh

# Build every guest component and compose the endpoint demo.
build-components:
    cargo build -p iroh-endpoint -p iroh-endpoint-demo -p iroh-exec-model-guest --target wasm32-wasip2 --release
    mkdir -p target/components
    wac plug target/wasm32-wasip2/release/iroh_endpoint_demo.wasm --plug target/wasm32-wasip2/release/iroh_endpoint.wasm -o target/components/iroh-demo.wasm
    # @polymorph/iroh's generated asset module (gitignored): host-polyengine's
    # `deno check src` and the jsr publish need it on disk.
    deno run --allow-read=target --allow-write=host-polyengine/src/endpoint_component.ts scripts/embed-endpoint-component.ts

# Build the Wasmtime host binary the gates drive, and the native
# interop peer. The exec-model probe driver is deliberately NOT here:
# it carries its own bindgen world (~45% of this build) and only the
# `probes` recipe needs it.
#
# One cargo invocation, not one per package: cargo unifies features
# across the packages selected in a single invocation, and the feature
# set feeds every unit hash — split invocations produce a different
# artifact universe for ~260 shared dependencies, so a CI cache saved
# by one shape misses entirely under the other.
build-hosts:
    cargo build -p iroh-host-wasmtime -p iroh-peer --bin endpoint-demo --bin iroh-peer --profile host

build: build-components build-hosts

# Native tests: the crypto/framing known answers.
test:
    cargo test -p iroh-endpoint-core
    cargo test -p iroh-endpoint-core --features guest-ed25519-signing

fmt-check:
    cargo fmt --all --check

clippy:
    cargo clippy --all-targets
    cargo clippy -p iroh-peer --all-targets
    cargo clippy -p iroh-endpoint -p iroh-endpoint-demo -p iroh-exec-model-guest --target wasm32-wasip2
    cargo clippy -p iroh-endpoint --features guest-ed25519-signing --target wasm32-wasip2

validate-wit:
    wasm-tools component wit wit/ > /dev/null
    wasm-tools component wit wit/ --all-features > /dev/null
    wasm-tools component wit core/wit/ > /dev/null
    wasm-tools component wit endpoint-demo/wit/ > /dev/null
    wasm-tools component wit experiments/exec-model/wit/ > /dev/null

# The execution-model probes on the Wasmtime host: the sync webcrypto
# bridge inside a spawned task and inside a detached pump, exported
# stream completion and reader-drop, and an imported stream sink.
#
# NOT part of `just ci`. Every behavior above is exercised by the
# endpoint surface on both hosts in the ordinary gates — the crypto
# bridge on every handshake, the stream paths by the stream-negative
# probe's read-via-stream and write-via-stream legs — so these probes
# now duplicate that coverage at the cost of a whole wasmtime
# embedding for their own world. They stay runnable, and they are the
# right first check when bumping wasmtime or wit-bindgen: they fail
# with a named probe where the endpoint fails diagnostically vaguely.
probes: build-components
    cargo build -p iroh-exec-model-guest --target wasm32-wasip2 --release
    cargo build -p iroh-host-wasmtime --bin exec-model --profile host
    target/host/exec-model target/wasm32-wasip2/release/iroh_exec_model_guest.wasm

# The cross-host pairing matrix: every demo pairing asserted in one run.
matrix: build
    ./scripts/matrix.sh

# The polyengine host's module graph + the node-datachannel addon (whose
# install script needs an explicit grant). Idempotent.
polyengine-setup:
    cd host-polyengine && deno install --frozen --allow-scripts=npm:node-datachannel

# The endpoint exam on the polyengine host: the endpoint component
# runtime-linked under stock Deno — lifecycle, wires, concurrency, and
# liveness/recovery scenarios. See host-polyengine/README.md.
exam-polyengine: build-components polyengine-setup
    #!/usr/bin/env bash
    set -euo pipefail
    # The two-line world (A22): exactly one RESOLVED @polyengine/runtime
    # lockstep-family version repo-wide (host-polyengine/README.md "The
    # pin"), and separately exactly one RESOLVED @polyengine/protocol
    # version — @polyengine/protocol is versioned independently, so its
    # presence alongside the runtime family in the lock is NOT drift, but
    # it must still be singular (protocol appearing at two versions would
    # mean two incompatible host-ABI vocabularies in one graph). The exam
    # is the natural fail-loud point, replacing the retired
    # fetch-translator gate. host-polyengine's published manifest carries
    # caret ranges, so specifier strings no longer pin identity; what
    # module identity needs is that every @polyengine/{runtime,translator,
    # wasi} package RESOLVES to the same version across both deno.locks —
    # a translator/runtime split is exactly the plan-format skew (or
    # double-runtime ComponentException identity break) the packaged
    # translator exists to rule out.
    v=$(jq -r '.jsr | keys[]' host-polyengine/deno.lock \
        experiments/iroh-relay-ws/host/deno.lock \
        | grep '^@polyengine/' | grep -v '^@polyengine/protocol@' \
        | sed 's/.*@//' | sort -u)
    if [ "$(printf '%s\n' "$v" | wc -l)" != 1 ]; then
        echo "polyengine pin drift across deno.locks: $v" >&2
        exit 1
    fi
    p=$(jq -r '.jsr | keys[]' host-polyengine/deno.lock \
        experiments/iroh-relay-ws/host/deno.lock \
        | grep '^@polyengine/protocol@' \
        | sed 's/.*@//' | sort -u)
    if [ "$(printf '%s\n' "$p" | wc -l)" != 1 ]; then
        echo "@polyengine/protocol pin drift across deno.locks: $p" >&2
        exit 1
    fi
    # ...and the RESOLVED graph must agree: one embedder instance, no raw
    # URLs (a sibling module's own config can silently split module
    # identity in a way no config grep catches; see the gate script).
    deno info --json --config host-polyengine/deno.json host-polyengine/src/run-endpoint.ts \
        | deno run scripts/polyengine-identity-gate.ts
    timeout 600 deno run -A --config host-polyengine/deno.json --frozen \
        host-polyengine/src/run-endpoint.ts

# The measured-claims gate: per-wire latency/throughput medians,
# asserted against budgets (issue #4).
bench: build
    ./scripts/bench.sh

# The endpoint against n0's production relays over wss (issue #2).
# Internet-dependent by nature, so manual: not part of `ci`.
interop-prod: build
    ./scripts/interop-prod.sh

# The upstream-iroh-over-relay spike (issue #14): the upstream iroh
# crate (the release + the wasi-enablement patch branches, from the
# lannbot/iroh and lannbot/net-tools polymorph-iroh branches) as a wasip2
# component, runtime-linked under polyengine on stock Deno — relay-only
# bootstrap over the polymorph-websocket sibling's polyengine module, then
# live migration onto a WebRTC data channel through the synthetic-address
# overlay (issue #26). Research probe attached to the issue, so manual:
# not part of `ci`.
iroh-relay-ws:
    cd experiments/iroh-relay-ws/guest && cargo build --release
    cd experiments/iroh-relay-ws/host && deno install --frozen --allow-scripts=npm:node-datachannel
    ./experiments/iroh-relay-ws/run.sh

# The fast pre-commit checks.
check: fmt-check clippy validate-wit test

# The exact set of checks CI runs: the CI job runs exactly one gha:: job
# recipe.
ci: (gha::checks)
