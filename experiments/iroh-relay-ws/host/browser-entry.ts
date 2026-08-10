// Browser driver: the run.ts flow without Deno specifics, reporting the
// outcome on `globalThis.__spike` for the Playwright harness
// (browser-test.mjs) to await and assert on.
//
// Bundled by browser-test.mjs with `deno bundle --platform browser` into
// dist/browser-entry.js; the page passes the translator-shim URL as the
// `translator` query parameter and the guest component is fetched
// relative to this experiment.

import { stats } from "./sockets.ts";
import { bridgeStats } from "./bridge.ts";
import { webrtcStats } from "./webrtc-bridge.ts";
import { guestImports, runGuest } from "./harness.ts";

const logEl = document.getElementById("log")!;
const t0 = performance.now();

try {
  const params = new URLSearchParams(location.search);
  const translatorUrl = params.get("translator");
  if (!translatorUrl) throw new Error("missing ?translator=<url> (see browser-test.mjs)");
  const fetchBytes = async (url: string): Promise<Uint8Array> => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`GET ${url}: ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  };
  const [translator, componentBytes] = await Promise.all([
    fetchBytes(translatorUrl),
    fetchBytes("../guest/target/wasm32-wasip2/release/iroh-relay-ws-guest.wasm"),
  ]);
  console.log(`[driver] loaded in ${(performance.now() - t0).toFixed(1)}ms`);

  const env: Record<string, string> = {};
  const rustLog = (globalThis as { RUST_LOG?: string }).RUST_LOG;
  if (rustLog) env.RUST_LOG = rustLog;

  await runGuest(
    { componentBytes, translator },
    guestImports({ args: ["iroh-relay-ws-guest"], env }),
  );
  const summary =
    `[driver] done in ${((performance.now() - t0) / 1000).toFixed(1)}s; ` +
    `polls=${stats.pollCalls} (suspended ${stats.pollSuspends}) ` +
    `datagrams in/out=${stats.datagramsIn}/${stats.datagramsOut} ` +
    `ws connections=${bridgeStats.connections} ws msgs in/out=${bridgeStats.wsIn}/${bridgeStats.wsOut} ` +
    `webrtc channels=${webrtcStats.channelsOpened} msgs in/out=${webrtcStats.in}/${webrtcStats.out} ` +
    `dropped-connecting=${webrtcStats.droppedWhileConnecting}`;
  console.log(summary);
  logEl.textContent = summary;
  (globalThis as { __spike?: unknown }).__spike = { ok: true };
} catch (err) {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[driver] failed: ${detail}`);
  logEl.textContent = `failed: ${detail}`;
  (globalThis as { __spike?: unknown }).__spike = { ok: false, error: detail };
}
