// Driver: wire the bridges, start the guest, and let it run its
// two-endpoint blob transfer over a live-migrating connection (relay ->
// WebRTC). The guest prints its own results; this driver adds a
// watchdog and the shim/bridge counters.
//
// Runs on stock Deno; the translator is `@deltic/translator`'s packaged
// asset, loaded through the module graph.

import { defaultTranslator } from "@deltic/translator";
import { stats } from "./sockets.ts";
import { bridgeStats } from "./bridge.ts";
import { webrtcStats } from "./webrtc-bridge.ts";
// harness.ts is the iroh-relay-ws spike's shared host wiring (artifact
// translation, the WASI import record, wasi:cli/run invocation); imported
// directly rather than re-exported like sockets/bridge/webrtc-bridge
// because run.ts itself has no surface for another experiment to share.
import { guestImports, runGuest } from "../../iroh-relay-ws/host/harness.ts";

const GUEST_WASM = new URL(
  "../guest/target/wasm32-wasip2/release/iroh-blobs-guest.wasm",
  import.meta.url,
);

const WATCHDOG_MS = Number(Deno.env.get("WATCHDOG_MS") ?? 120_000);

const watchdog = setTimeout(() => {
  console.error(`[driver] watchdog: guest did not finish in ${WATCHDOG_MS}ms`);
  console.error(`[driver] stats: ${JSON.stringify({ ...stats, ...bridgeStats })}`);
  Deno.exit(1);
}, WATCHDOG_MS);

const t0 = performance.now();
const artifacts = {
  componentBytes: await Deno.readFile(GUEST_WASM),
  translator: await defaultTranslator(),
};
console.log(`[driver] loaded in ${(performance.now() - t0).toFixed(1)}ms`);

// Guest knobs (BLOB_MB, RELAY) pass through as guest env, same as the old
// jco driver's GUEST_ENV.
const env: Record<string, string> = {};
const rustLog = Deno.env.get("RUST_LOG");
if (rustLog) env.RUST_LOG = rustLog;
const blobMb = Deno.env.get("BLOB_MB");
if (blobMb) env.BLOB_MB = blobMb;
const relay = Deno.env.get("RELAY");
if (relay) env.RELAY = relay;

await runGuest(artifacts, guestImports({ args: ["iroh-blobs-guest"], env }));
clearTimeout(watchdog);

console.log(
  `[driver] done in ${((performance.now() - t0) / 1000).toFixed(1)}s; ` +
    `datagrams in/out=${stats.datagramsIn}/${stats.datagramsOut} ` +
    `ws connections=${bridgeStats.connections} ws msgs in/out=${bridgeStats.wsIn}/${bridgeStats.wsOut} ` +
    `webrtc channels=${webrtcStats.channelsOpened} msgs in/out=${webrtcStats.in}/${webrtcStats.out} ` +
    `dropped-connecting=${webrtcStats.droppedWhileConnecting}`,
);

// The webrtc peer connections hold the event loop open; the guest is done.
Deno.exit(0);
