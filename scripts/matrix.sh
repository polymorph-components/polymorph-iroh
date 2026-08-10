#!/usr/bin/env bash
# The repeatable cross-host gate: every demo pairing this repository
# claims works, asserted in one run. Requires the components and hosts
# already built (`just build`) and the iroh-relay binary present
# (`just relay-build`). Prints one PASS/FAIL line per pairing and exits
# nonzero if any failed.
set -u
cd "$(dirname "$0")/.."

RELAY_PORT=3341
RELAY_URL="http://127.0.0.1:${RELAY_PORT}"
# A second, independent relay for the cross-relay rows.
RELAY_B_PORT=3342
RELAY_B_URL="http://127.0.0.1:${RELAY_B_PORT}"
SPIKE_WASM=target/wasm32-wasip2/release/iroh_spike_guest.wasm
COMPOSED_WASM=target/components/iroh-demo.wasm
HOST=target/release/iroh-spike-host
EHOST=target/release/endpoint-demo
IROH_PEER=target/release/iroh-peer
LOGDIR=$(mktemp -d)
FAILURES=0

# --- infrastructure -------------------------------------------------------

cat > "$LOGDIR/relay.toml" <<EOF
http_bind_addr = "127.0.0.1:${RELAY_PORT}"
enable_metrics = false
EOF
.deps/iroh/target/release/iroh-relay --dev -c "$LOGDIR/relay.toml" \
    > "$LOGDIR/relay.log" 2>&1 &
RELAY_PID=$!
cat > "$LOGDIR/relay-b.toml" <<EOF
http_bind_addr = "127.0.0.1:${RELAY_B_PORT}"
enable_metrics = false
EOF
.deps/iroh/target/release/iroh-relay --dev -c "$LOGDIR/relay-b.toml" \
    > "$LOGDIR/relay-b.log" 2>&1 &
RELAY_B_PID=$!
trap 'kill $RELAY_PID $RELAY_B_PID 2>/dev/null' EXIT
sleep 1

# Start a server peer, scrape its endpoint id, run the client peer, and
# assert both reported OK.
#   run_pair <name> <server-cmd...> -- <client-cmd...>
# The client command receives the server's endpoint id appended after
# its own --peer flag. A literal `@DIRECT@` client argument is replaced
# by the server's scraped `direct-addr <ip:port>` line (the UDP rows).
run_pair() {
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
        echo "FAIL $name (server printed no endpoint id)"
        kill "$server_pid" 2>/dev/null
        FAILURES=$((FAILURES + 1))
        return
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
                echo "FAIL $name (server printed no direct-addr)"
                kill "$server_pid" 2>/dev/null
                FAILURES=$((FAILURES + 1))
                return
            fi
            client[$i]="$direct"
        fi
    done

    "${client[@]}" "$server_id" > "$LOGDIR/$name-client.log" 2>&1
    local client_status=$?
    wait "$server_pid" 2>/dev/null
    local server_status=$?
    if [ "$client_status" = 0 ] && [ "$server_status" = 0 ] \
        && grep -q "^OK:" "$LOGDIR/$name-client.log" \
        && grep -q "^OK:" "$LOGDIR/$name-server.log"; then
        echo "PASS $name"
    else
        echo "FAIL $name (client=$client_status server=$server_status; logs in $LOGDIR)"
        FAILURES=$((FAILURES + 1))
    fi
}


# --- spike demo: both wires, wasmtime pairing ------------------------------

for wire in webrtc relay; do
    run_pair "spike-$wire-wasmtime-wasmtime" \
        env WEBRTC_INCLUDE_LOOPBACK=1 timeout 120 "$HOST" "$SPIKE_WASM" \
            --role server --server "$RELAY_URL" --transport "$wire" -- \
        env WEBRTC_INCLUDE_LOOPBACK=1 timeout 120 "$HOST" "$SPIKE_WASM" \
            --role client --server "$RELAY_URL" --transport "$wire" \
            --message "matrix $wire" --peer
done

# --- endpoint surface: the wac-composed demo under wasmtime ---------------
#
# The jco leg of the endpoint surface retired with the jco host: its
# per-component execution slot serialized whole task lifetimes, so the
# detached pump task (alive with in-flight imports across export calls)
# deadlocked every later export call (lann/jco#11, fix attempts in
# lann/jco PR #27). host-deltic runs this surface under stock Deno
# instead (see host-deltic/README.md); `just exam-deltic` is its gate.

run_pair "endpoint-relay-wasmtime-wasmtime" \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role server --relay "$RELAY_URL" \
        --datagram -- \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role client --relay "$RELAY_URL" \
        --datagram --message "matrix endpoint" --peer

# Embedder-injected identity: both sides mint an Ed25519 pair inside
# the demo component through polymorph:webcrypto and construct the
# identity via identity-from-keys (the other rows construct theirs via
# identity-generate). The demo fails unless the endpoint reports the
# constructed identity's public key as its endpoint-id, so a passing
# echo asserts bind adopted the supplied pair on both roles (the
# client additionally authenticated the server's injected identity end
# to end).
run_pair "endpoint-identity-wasmtime-wasmtime" \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role server --relay "$RELAY_URL" \
        --inject-identity -- \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role client --relay "$RELAY_URL" \
        --inject-identity --message "matrix identity" --peer

# The UDP direct path: the server binds a real socket (port 0 =
# ephemeral) and the client dials the scraped address. The client
# must bind its own socket too — without one, connect() ignores ip
# entries (the recorded narrowing) and would quietly assert the relay
# path instead. connect() prefers the ip entry with no relay
# fallback, so a passing echo is the assertion that QUIC flowed over
# UDP.
run_pair "endpoint-udp-wasmtime-wasmtime" \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role server --relay "$RELAY_URL" \
        --udp-bind 127.0.0.1:0 --datagram -- \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role client --relay "$RELAY_URL" \
        --udp-bind 127.0.0.1:0 --datagram --message "matrix udp" --direct @DIRECT@ --peer

# The WebRTC wire: SDP/ICE signaled through the relay (a 0x00-prefixed
# datagram convention a stock relay just forwards), then QUIC over the
# unreliable channel. connect() prefers the webrtc entry with no relay
# fallback, so a passing echo is the assertion that QUIC flowed over
# the channel; the relay carried only signaling for this connection.
run_pair "endpoint-webrtc-wasmtime-wasmtime" \
    env WEBRTC_INCLUDE_LOOPBACK=1 timeout 120 "$EHOST" "$COMPOSED_WASM" \
        --role server --relay "$RELAY_URL" --webrtc --datagram -- \
    env WEBRTC_INCLUDE_LOOPBACK=1 timeout 120 "$EHOST" "$COMPOSED_WASM" \
        --role client --relay "$RELAY_URL" --webrtc --datagram \
        --message "matrix webrtc" --peer

# Cross-relay: the server homes on relay B, the client on relay A. The
# client's addr entries name relay B, so the dial opens a pooled
# connection to the foreign relay and QUIC flows through it.
run_pair "endpoint-relay-cross-wasmtime-wasmtime" \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role server --relay "$RELAY_B_URL" -- \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role client --relay "$RELAY_URL" \
        --peer-relay "$RELAY_B_URL" --message "matrix cross-relay" --peer

# Cross-relay WebRTC: signaling crosses to the peer's relay, then the
# upgrade moves the packets off relays entirely (the client's bounded
# wait for path=webrtc is the assertion).
run_pair "endpoint-webrtc-cross-wasmtime-wasmtime" \
    env WEBRTC_INCLUDE_LOOPBACK=1 timeout 120 "$EHOST" "$COMPOSED_WASM" \
        --role server --relay "$RELAY_B_URL" --webrtc -- \
    env WEBRTC_INCLUDE_LOOPBACK=1 timeout 120 "$EHOST" "$COMPOSED_WASM" \
        --role client --relay "$RELAY_URL" --webrtc --peer-relay "$RELAY_B_URL" \
        --message "matrix webrtc cross" --peer

# --- upstream interop: wire-format compatibility with iroh v1 -------------
#
# The same echo against the real iroh implementation (tools/iroh-peer:
# loopback UDP only, relays and discovery disabled), in both directions.
# The upstream peer plays no part in our relay; a passing echo proves
# the QUIC + RPK-TLS wire against upstream, not just against ourselves.

run_pair "interop-udp-ours-client" \
    timeout 120 "$IROH_PEER" --role server --datagram -- \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role client --relay "$RELAY_URL" \
        --udp-bind 127.0.0.1:0 --datagram --message "interop ours-client" \
        --direct @DIRECT@ --peer

run_pair "interop-udp-theirs-client" \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role server --relay "$RELAY_URL" \
        --udp-bind 127.0.0.1:0 --datagram -- \
    timeout 120 "$IROH_PEER" --role client --datagram \
        --message "interop theirs-client" --direct @DIRECT@ --peer

# --- endpoint surface: failure paths must fail closed, in bounded time ----
#
# The identity-is-the-address design leaves two failure probes buildable
# with honest components: an ALPN the server does not serve (a real TLS
# handshake rejection through the whole stack), and a peer that does not
# exist (the connect must time out, not hang). The wrong-key TLS pin
# rejection itself is asserted by component-tls's rpk handshake tests.

# Start a server, run a client expected to FAIL, assert it fails with a
# connect-shaped error; the server never completes and is killed.
#   run_client_failure <name> <with-server 0|1> <client-cmd...>
run_client_failure() {
    local name=$1 with_server=$2; shift 2
    local server_pid="" server_id="0000000000000000000000000000000000000000000000000000000000000000"
    if [ "$with_server" = 1 ]; then
        timeout 120 "$EHOST" "$COMPOSED_WASM" --role server --relay "$RELAY_URL" \
            > "$LOGDIR/$name-server.log" 2>&1 &
        server_pid=$!
        for _ in $(seq 1 60); do
            server_id=$(grep -m1 "^endpoint-id" "$LOGDIR/$name-server.log" 2>/dev/null | awk '{print $2}')
            [ -n "$server_id" ] && break
            sleep 0.5
        done
    fi

    "$@" "$server_id" > "$LOGDIR/$name-client.log" 2>&1
    local client_status=$?
    [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null

    if [ "$client_status" != 0 ] && [ "$client_status" != 124 ] \
        && grep -qi "connect" "$LOGDIR/$name-client.log" \
        && ! grep -q "^OK:" "$LOGDIR/$name-client.log"; then
        echo "PASS $name"
    else
        echo "FAIL $name (client=$client_status, expected a bounded connect failure; logs in $LOGDIR)"
        FAILURES=$((FAILURES + 1))
    fi
}

run_client_failure "endpoint-negative-wrong-alpn" 1 \
    timeout 60 "$EHOST" "$COMPOSED_WASM" --role client --relay "$RELAY_URL" \
        --alpn "iroh-demo-negative/0" --peer

run_client_failure "endpoint-negative-absent-peer" 0 \
    timeout 60 "$EHOST" "$COMPOSED_WASM" --role client --relay "$RELAY_URL" \
        --peer

# --------------------------------------------------------------------------

if [ "$FAILURES" != 0 ]; then
    echo "matrix: $FAILURES pairing(s) failed (logs in $LOGDIR)"
    exit 1
fi
echo "matrix: all pairings passed"
rm -rf "$LOGDIR"
