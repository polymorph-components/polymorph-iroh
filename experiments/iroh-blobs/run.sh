#!/usr/bin/env bash
# Runs the iroh-blobs spike end to end: the pinned iroh-relay binary
# (scripts/setup.sh), then the deltic host on stock Deno driving the
# wasip2 guest — runtime-linked, no transpile step; the translator ships
# in the pinned @deltic/translator package.
# Reuses an already-running relay on 127.0.0.1:3340; kills only what it
# started.
set -euo pipefail
cd "$(dirname "$0")"

RELAY_BIN=iroh-relay
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

timeout 120 deno run -A --config ../iroh-relay-ws/host/deno.json --frozen host/run.ts
