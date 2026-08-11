#!/usr/bin/env bash
# Builds the ping demo into web/site/: guest component (cargo), deltic
# build-time translation (A4 envelope), and the bundled page — the site
# must be self-contained (GitHub Pages, and COEP blocks anything
# cross-origin without CORP anyway). Runtime host layer (sockets, bridge,
# webrtc-bridge, harness) is the iroh-relay-ws spike's, imported directly
# by web/demo.ts and inlined by the bundler — no copying, no sed rewrites.
set -euo pipefail
cd "$(dirname "$0")"

SPIKE_HOST=../iroh-relay-ws/host
SITE=web/site
GUEST_WASM=guest/target/wasm32-wasip2/release/ping-demo-guest.wasm

(cd guest && cargo build --release)

rm -rf "$SITE"
mkdir -p "$SITE"

# Build-time translation (deltic embedder-api A4): produces the
# component-plus-plan envelope the page fetches at runtime. The
# translator is @deltic/translator's packaged asset at the same pinned
# release as the runtime the bundle carries, so the envelope's plan
# format matches by construction.
deno run --config "$SPIKE_HOST/deno.json" --frozen --allow-read --allow-write \
    "$SPIKE_HOST/translate.ts" "$GUEST_WASM" "$SITE/ping-demo.plan.json"

cp "$GUEST_WASM" "$SITE/ping-demo.component.wasm"

# Bundle the page: demo.ts pulls in the shared host layer (sockets,
# harness, bridge) and the sibling webrtc/qrcode modules; the bundle is
# self-contained.
deno bundle --config "$SPIKE_HOST/deno.json" --platform browser \
    --external node-datachannel/polyfill --external werift \
    -o "$SITE/demo.js" web/demo.ts

cp web/index.html "$SITE/"
# Pages runs Jekyll by default, which drops directories it dislikes.
touch "$SITE/.nojekyll"

echo "site assembled in $SITE ($(du -sh "$SITE" | cut -f1))"
