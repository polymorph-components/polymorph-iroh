#!/usr/bin/env bash
# Runs the iroh-blobs spike end to end: a stock iroh-relay server (from
# .deps/iroh, built by the just recipe), then the deltic host on stock
# Deno driving the wasip2 guest — runtime-linked, no transpile step.
# Reuses an already-running relay on 127.0.0.1:3340; kills only what it
# started.
set -euo pipefail
cd "$(dirname "$0")"

RELAY_BIN=../../.deps/iroh/target/release/iroh-relay
RELAY_PID=""

if ! curl -s -m 2 http://127.0.0.1:3340 >/dev/null 2>&1; then
    "$RELAY_BIN" --dev >/tmp/iroh-blobs-spike-relay.log 2>&1 &
    RELAY_PID=$!
    trap '[ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null || true' EXIT
    for _ in $(seq 1 20); do
        curl -s -m 1 http://127.0.0.1:3340 >/dev/null 2>&1 && break
        sleep 0.25
    done
fi

# The sha256-pinned translator shim, cached under target/deltic/ (the pin
# and the cache live with host-deltic; the deltic tag in
# ../iroh-relay-ws/host/deno.json — the shared config for every
# experiment — matches it).
shim=$(deno run --config ../../host-deltic/deno.json --frozen \
    --allow-read=../.. --allow-write=../../target/deltic \
    --allow-net=github.com,objects.githubusercontent.com,release-assets.githubusercontent.com \
    ../../host-deltic/fetch-translator.ts)

DELTIC_TRANSLATOR="$shim" timeout 120 \
    deno run -A --config ../iroh-relay-ws/host/deno.json --frozen host/run.ts
