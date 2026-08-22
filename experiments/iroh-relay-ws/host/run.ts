// Driver: wire the bridges, start the guest, and let it run its
// two-endpoint relay echo + WebRTC migration. The guest prints its own
// results; this driver adds a watchdog and the shim/bridge counters.
//
// Runs on stock Deno; the translator is `@polyengine/translator`'s packaged
// asset, loaded through the module graph.

import { defaultTranslator } from "@polyengine/translator";
import { stats } from "./sockets.ts";
import { bridgeStats } from "./bridge.ts";
import { webrtcStats } from "./webrtc-bridge.ts";
import { guestImports, runGuest } from "./harness.ts";

const GUEST_WASM = new URL(
  "../guest/target/wasm32-wasip2/release/iroh-relay-ws-guest.wasm",
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

const env: Record<string, string> = {};
const rustLog = Deno.env.get("RUST_LOG");
if (rustLog) env.RUST_LOG = rustLog;

await runGuest(artifacts, guestImports({ args: ["iroh-relay-ws-guest"], env }));
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
