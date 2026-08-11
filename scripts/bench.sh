#!/usr/bin/env bash
# The measured-claims gate: per-wire handshake and roundtrip medians and
# bulk-transfer throughput, asserted against the budgets below. The
# numbers land in target/bench/report.tsv (and stdout); the budgets are
# the recorded invariants — a number that matters is asserted here, not
# written in prose. Requires the same artifacts as the matrix
# (`just build`, `just relay-build`).
set -u
cd "$(dirname "$0")/.."

# --- budgets ---------------------------------------------------------------
#
# Time ceilings are deliberately loose: they catch order-of-magnitude
# regressions (a lost first flight, a stalled pump) without flaking on
# shared CI runners. The event-driven-pump claim (issue #42) is asserted
# separately, as a bound on the spike-to-endpoint handshake delta:
# both rows ride the same wire, relay, and run, so the delta cancels
# runner noise that absolute ceilings must tolerate.

HANDSHAKE_CEILING_MS=250
ROUNDTRIP_CEILING_MS=250
POLLING_TAX_CEILING_MS=10
BULK_FLOOR_MBPS=1.0

RELAY_PORT=3341
RELAY_URL="http://127.0.0.1:${RELAY_PORT}"
SPIKE_WASM=target/wasm32-wasip2/release/iroh_spike_guest.wasm
COMPOSED_WASM=target/components/iroh-demo.wasm
HOST=target/release/iroh-spike-host
EHOST=target/release/endpoint-demo
LOGDIR=$(mktemp -d)
OUTDIR=target/bench
REPORT=$OUTDIR/report.tsv
FAILURES=0
LATENCY_ITERS=5
BULK_ITERS=3
BULK_BYTES=$((4 * 1024 * 1024))

mkdir -p "$OUTDIR"
: > "$REPORT"

cat > "$LOGDIR/relay.toml" <<EOF
http_bind_addr = "127.0.0.1:${RELAY_PORT}"
enable_metrics = false
EOF
.deps/iroh/target/release/iroh-relay --dev -c "$LOGDIR/relay.toml" \
    > "$LOGDIR/relay.log" 2>&1 &
RELAY_PID=$!
trap 'kill $RELAY_PID 2>/dev/null' EXIT
sleep 1

median() {
    printf '%s\n' "$@" | sort -n | awk '{ a[NR] = $1 } END { print a[int((NR + 1) / 2)] }'
}

emit() {
    printf '%s\t%s\t%s\n' "$1" "$2" "$3" | tee -a "$REPORT"
}

fail() {
    echo "BUDGET-FAIL $1"
    FAILURES=$((FAILURES + 1))
}

# One server+client exchange; the client's report line is echoed on
# stdout (failures go to stderr — callers capture stdout).
#   run_once <logname> <server-cmd...> -- <client-cmd...>
# The client command receives the server's endpoint id appended (after
# its trailing --peer flag); a literal `@DIRECT@` argument is replaced
# by the server's scraped `direct-addr` line, like the matrix.
run_once() {
    local name=$1; shift
    local server=()
    while [ "$1" != "--" ]; do server+=("$1"); shift; done
    shift
    local client=("$@")

    "${server[@]}" > "$LOGDIR/$name-server.log" 2>&1 &
    local server_pid=$!
    local server_id=""
    for _ in $(seq 1 60); do
        server_id=$(grep -m1 "^endpoint-id" "$LOGDIR/$name-server.log" 2>/dev/null | awk '{print $2}')
        [ -n "$server_id" ] && break
        sleep 0.5
    done
    if [ -z "$server_id" ]; then
        kill "$server_pid" 2>/dev/null
        echo "RUN-FAIL $name: server printed no endpoint id (logs in $LOGDIR)" >&2
        return 1
    fi

    local i
    for i in "${!client[@]}"; do
        if [ "${client[$i]}" = "@DIRECT@" ]; then
            local direct=""
            for _ in $(seq 1 60); do
                direct=$(grep -m1 "^direct-addr" "$LOGDIR/$name-server.log" 2>/dev/null | awk '{print $2}')
                [ -n "$direct" ] && break
                sleep 0.5
            done
            if [ -z "$direct" ]; then
                kill "$server_pid" 2>/dev/null
                echo "RUN-FAIL $name: server printed no direct-addr (logs in $LOGDIR)" >&2
                return 1
            fi
            client[$i]="$direct"
        fi
    done

    "${client[@]}" "$server_id" > "$LOGDIR/$name-client.log" 2>&1
    local client_status=$?
    wait "$server_pid" 2>/dev/null
    if [ "$client_status" != 0 ]; then
        echo "RUN-FAIL $name: client exited $client_status (logs in $LOGDIR)" >&2
        return 1
    fi
    grep -m1 "handshake_ms=" "$LOGDIR/$name-client.log"
}

# Median handshake/roundtrip over N iterations of a pairing. Leaves the
# handshake median in LAST_HANDSHAKE_MS for cross-row assertions.
#   bench_latency <row> <iters> <server-cmd...> -- <client-cmd...>
bench_latency() {
    local row=$1 iters=$2; shift 2
    LAST_HANDSHAKE_MS=""
    local handshakes=() roundtrips=()
    for i in $(seq 1 "$iters"); do
        local line
        line=$(run_once "$row-$i" "$@") || { FAILURES=$((FAILURES + 1)); return; }
        handshakes+=("$(sed -n 's/.*handshake_ms=\([0-9]*\).*/\1/p' <<< "$line")")
        roundtrips+=("$(sed -n 's/.*roundtrip_ms=\([0-9]*\).*/\1/p' <<< "$line")")
    done
    local hs rt
    hs=$(median "${handshakes[@]}")
    rt=$(median "${roundtrips[@]}")
    emit "$row" handshake_ms_median "$hs"
    emit "$row" roundtrip_ms_median "$rt"
    [ "$hs" -le "$HANDSHAKE_CEILING_MS" ] || fail "$row handshake ${hs}ms > ${HANDSHAKE_CEILING_MS}ms"
    [ "$rt" -le "$ROUNDTRIP_CEILING_MS" ] || fail "$row roundtrip ${rt}ms > ${ROUNDTRIP_CEILING_MS}ms"
    LAST_HANDSHAKE_MS=$hs
}

# Median bulk-echo throughput (payload out and back) over N iterations.
#   bench_bulk <row> <iters> <server-cmd...> -- <client-cmd...>
bench_bulk() {
    local row=$1 iters=$2; shift 2
    local roundtrips=()
    for i in $(seq 1 "$iters"); do
        local line
        line=$(run_once "$row-$i" "$@") || { FAILURES=$((FAILURES + 1)); return; }
        roundtrips+=("$(sed -n 's/.*roundtrip_ms=\([0-9]*\).*/\1/p' <<< "$line")")
    done
    local rt mbps
    rt=$(median "${roundtrips[@]}")
    mbps=$(awk -v b="$BULK_BYTES" -v ms="$rt" 'BEGIN { printf "%.1f", (2 * b) / 1048576 / (ms / 1000) }')
    emit "$row" bulk_roundtrip_ms_median "$rt"
    emit "$row" throughput_mbps "$mbps"
    awk -v got="$mbps" -v floor="$BULK_FLOOR_MBPS" 'BEGIN { exit !(got >= floor) }' \
        || fail "$row throughput ${mbps}MB/s < ${BULK_FLOOR_MBPS}MB/s"
}

# --- latency rows ----------------------------------------------------------
#
# The spike (single-task, event-driven pump) is the baseline the
# composed endpoint is compared against: the handshake delta between
# spike-relay and endpoint-relay is the price of the endpoint's
# resource surface (export-call tasks woken by the pump), asserted
# below against POLLING_TAX_CEILING_MS so the bounded-polling tax
# retired by issue #42 cannot quietly return.

bench_latency spike-relay-wasmtime "$LATENCY_ITERS" \
    timeout 120 "$HOST" "$SPIKE_WASM" --role server --server "$RELAY_URL" --transport relay -- \
    timeout 120 "$HOST" "$SPIKE_WASM" --role client --server "$RELAY_URL" --transport relay \
        --message bench --peer
SPIKE_RELAY_HS=$LAST_HANDSHAKE_MS

bench_latency endpoint-relay-wasmtime "$LATENCY_ITERS" \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role server --relay "$RELAY_URL" -- \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role client --relay "$RELAY_URL" \
        --message bench --peer

if [ -n "$SPIKE_RELAY_HS" ] && [ -n "$LAST_HANDSHAKE_MS" ]; then
    TAX=$((LAST_HANDSHAKE_MS - SPIKE_RELAY_HS))
    emit endpoint-relay-wasmtime handshake_tax_ms "$TAX"
    [ "$TAX" -le "$POLLING_TAX_CEILING_MS" ] ||
        fail "endpoint-relay handshake ${LAST_HANDSHAKE_MS}ms exceeds spike ${SPIKE_RELAY_HS}ms by ${TAX}ms > ${POLLING_TAX_CEILING_MS}ms"
fi

bench_latency endpoint-udp-wasmtime "$LATENCY_ITERS" \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role server --relay "$RELAY_URL" \
        --udp-bind 127.0.0.1:0 -- \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role client --relay "$RELAY_URL" \
        --udp-bind 127.0.0.1:0 --message bench --direct @DIRECT@ --peer

# handshake_ms is the relay dial; roundtrip_ms rides the upgraded
# channel (the demo waits for path=webrtc before sending).
bench_latency endpoint-webrtc-wasmtime "$LATENCY_ITERS" \
    env WEBRTC_INCLUDE_LOOPBACK=1 timeout 120 "$EHOST" "$COMPOSED_WASM" \
        --role server --relay "$RELAY_URL" --webrtc -- \
    env WEBRTC_INCLUDE_LOOPBACK=1 timeout 120 "$EHOST" "$COMPOSED_WASM" \
        --role client --relay "$RELAY_URL" --webrtc --message bench --peer

# --- bulk rows (#1: the wires' data-plane cost, incl. CC stacking) ---------

bench_bulk endpoint-relay-bulk "$BULK_ITERS" \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role server --relay "$RELAY_URL" -- \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role client --relay "$RELAY_URL" \
        --payload-bytes "$BULK_BYTES" --peer

bench_bulk endpoint-udp-bulk "$BULK_ITERS" \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role server --relay "$RELAY_URL" \
        --udp-bind 127.0.0.1:0 -- \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role client --relay "$RELAY_URL" \
        --udp-bind 127.0.0.1:0 --payload-bytes "$BULK_BYTES" --direct @DIRECT@ --peer

bench_bulk endpoint-webrtc-bulk "$BULK_ITERS" \
    env WEBRTC_INCLUDE_LOOPBACK=1 timeout 120 "$EHOST" "$COMPOSED_WASM" \
        --role server --relay "$RELAY_URL" --webrtc -- \
    env WEBRTC_INCLUDE_LOOPBACK=1 timeout 120 "$EHOST" "$COMPOSED_WASM" \
        --role client --relay "$RELAY_URL" --webrtc --payload-bytes "$BULK_BYTES" --peer

# ---------------------------------------------------------------------------

if [ "$FAILURES" != 0 ]; then
    echo "bench: $FAILURES budget(s) violated (logs in $LOGDIR)"
    exit 1
fi
echo "bench: all budgets hold (report: $REPORT)"
rm -rf "$LOGDIR"
