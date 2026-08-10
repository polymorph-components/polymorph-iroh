// Live check against the deployed GitHub Pages demo: real Chromium, real
// n0 public relays, real STUN. Host + joiner, full flow.
import { chromium } from "playwright";

const URL = process.argv[2] ?? "https://polymorph-components.github.io/polymorph-iroh/";
const TIMEOUT = 120_000;

const browser = await chromium.launch();
const context = await browser.newContext();

async function open(name, url) {
  const page = await context.newPage();
  page.on("console", (m) => console.log(`[${name}] ${m.text()}`));
  page.on("pageerror", (e) => console.error(`[${name}] pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}

try {
  const host = await open("host", URL);
  const joinUrl = await host
    .waitForFunction(() => globalThis.__demo?.joinUrl, { timeout: TIMEOUT })
    .then((h) => h.jsonValue());
  console.log(`[live] session up on n0 relay; join url: ${joinUrl.slice(0, 100)}…`);

  const joiner = await open("join", joinUrl);
  for (const [n, p] of [["host", host], ["join", joiner]]) {
    await p.waitForFunction(() => ["connected", "live"].includes(globalThis.__demo?.state), {
      timeout: TIMEOUT,
    });
    console.log(`[live] ${n} connected`);
  }
  for (const [n, p] of [["host", host], ["join", joiner]]) {
    await p.waitForFunction(() => globalThis.__demo?.path === "direct", { timeout: TIMEOUT });
    console.log(
      `[live] ${n} migrated to direct: rtt=${await p.evaluate(() => globalThis.__demo.rttUs)}us`,
    );
  }
  await host.click("#view", { position: { x: 120, y: 120 } });
  await joiner.waitForFunction(() => globalThis.__demo?.remotePings >= 1, { timeout: TIMEOUT });
  console.log("[live] ping mirrored host->join");
  await joiner.click("#view", { position: { x: 80, y: 80 } });
  await host.waitForFunction(() => globalThis.__demo?.remotePings >= 1, { timeout: TIMEOUT });
  console.log("[live] ping mirrored join->host");

  // File drop: 1MiB host -> joiner, bao-verified by iroh-blobs.
  const payload = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) & 0xff;
  await host.setInputFiles("#file", {
    name: "live.bin",
    mimeType: "application/octet-stream",
    buffer: payload,
  });
  await joiner.waitForFunction(
    () =>
      globalThis.__demo.transfers.some(
        (t) => t.name === "live.bin" && t.state === "done" && t.bytes === t.size,
      ),
    { timeout: TIMEOUT },
  );
  console.log("[live] file transferred and verified");
  console.log("[live] PASS — deployed demo works over public relays");
} catch (err) {
  console.error(`[live] FAIL: ${err}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
