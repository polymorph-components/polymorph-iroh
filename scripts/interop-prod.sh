#!/usr/bin/env bash
# The production-relay interop check (issue #2): the endpoint against
# n0's real relay infrastructure over wss — same-relay echo, the WebRTC
# upgrade with signaling forwarded by a production relay, and a
# cross-relay dial between two production relays. Manual by design:
# it depends on the public internet and third-party infrastructure, so
# it is not part of `just ci` (the gate stays hermetic); run it when
# touching the relay wire, the websocket path, or the frame encodings.
#
#   PROD_RELAY_A / PROD_RELAY_B   override the relay URLs
set -u
cd "$(dirname "$0")/.."

PROD_RELAY_A="${PROD_RELAY_A:-https://use1-1.relay.n0.iroh.link}"
PROD_RELAY_B="${PROD_RELAY_B:-https://euc1-1.relay.n0.iroh.link}"
COMPOSED_WASM=target/components/iroh-demo.wasm
EHOST=target/host/endpoint-demo
LOGDIR=$(mktemp -d)
FAILURES=0

# One server+client exchange, asserting both sides' OK lines and an
# expected `path=` in the client's report.
#   check <name> <expected-path> <server-cmd...> -- <client-cmd...>
check() {
    local name=$1 expected_path=$2; shift 2
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
        echo "FAIL $name (server printed no endpoint id; logs in $LOGDIR)"
        kill "$server_pid" 2>/dev/null
        FAILURES=$((FAILURES + 1))
        return
    fi

    "${client[@]}" "$server_id" > "$LOGDIR/$name-client.log" 2>&1
    local client_status=$?
    wait "$server_pid" 2>/dev/null
    local server_status=$?
    local report
    report=$(grep -m1 "handshake_ms=" "$LOGDIR/$name-client.log")
    if [ "$client_status" = 0 ] && [ "$server_status" = 0 ] \
        && grep -q "^OK:" "$LOGDIR/$name-client.log" \
        && grep -q "^OK:" "$LOGDIR/$name-server.log" \
        && grep -q "path=$expected_path" <<< "$report"; then
        echo "PASS $name ($report)"
    else
        echo "FAIL $name (client=$client_status server=$server_status; logs in $LOGDIR)"
        FAILURES=$((FAILURES + 1))
    fi
}

check prod-relay-echo relay \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role server --relay "$PROD_RELAY_A" -- \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role client --relay "$PROD_RELAY_A" \
        --message "prod relay echo" --peer

# Signaling datagrams (the 0x00-prefix convention) must forward through
# production infrastructure unmodified; the echo then rides the local
# channel while only signaling crossed the internet.
check prod-webrtc-upgrade webrtc \
    env WEBRTC_INCLUDE_LOOPBACK=1 timeout 120 "$EHOST" "$COMPOSED_WASM" \
        --role server --relay "$PROD_RELAY_A" --webrtc -- \
    env WEBRTC_INCLUDE_LOOPBACK=1 timeout 120 "$EHOST" "$COMPOSED_WASM" \
        --role client --relay "$PROD_RELAY_A" --webrtc \
        --message "prod webrtc upgrade" --peer

check prod-cross-relay relay \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role server --relay "$PROD_RELAY_B" -- \
    timeout 120 "$EHOST" "$COMPOSED_WASM" --role client --relay "$PROD_RELAY_A" \
        --peer-relay "$PROD_RELAY_B" --message "prod cross relay" --peer

if [ "$FAILURES" != 0 ]; then
    echo "interop-prod: $FAILURES check(s) failed (logs in $LOGDIR)"
    exit 1
fi
echo "interop-prod: all checks passed"
rm -rf "$LOGDIR"
