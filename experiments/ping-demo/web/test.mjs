// Playwright validation for the ping demo: host page + joiner page in one
// Chromium, local relay, real page-ferried signaling. Asserts the session
// bootstraps via the join URL (the QR payload), pings mirror both ways,
// and the connection live-migrates off the relay onto the data channel.
//
// Usage: node test.mjs [--headed]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const SITE = fileURLToPath(new URL("./site", import.meta.url));
const RELAY_BIN = "iroh-relay";
const RELAY_URL = "http://127.0.0.1:3340";
const TIMEOUT = 60_000;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

async function relayUp() {
  try {
    await fetch(RELAY_URL, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function ensureRelay() {
  if (await relayUp()) return null;
  const proc = spawn(RELAY_BIN, ["--dev"], { stdio: "ignore" });
  for (let i = 0; i < 20; i++) {
    if (await relayUp()) return proc;
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error("relay did not come up");
}

function serve() {
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/") path = "/index.html";
    try {
      const body = await readFile(join(SITE, path));
      res.writeHead(200, {
        "content-type": MIME[extname(path)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function openPage(context, name, url) {
  const page = await context.newPage();
  page.on("console", (msg) => console.log(`[${name}] ${msg.text()}`));
  page.on("pageerror", (err) => console.error(`[${name}] pageerror: ${err.message}`));
  if (process.env.RUST_LOG) {
    const rustLog = process.env.RUST_LOG;
    await page.addInitScript((v) => {
      globalThis.RUST_LOG = v;
    }, rustLog);
  }
  await page.goto(url);
  return page;
}

async function dumpState(name, page) {
  try {
    const state = await page.evaluate(() =>
      JSON.stringify({ ...globalThis.__demo, lastRemotePing: undefined }),
    );
    console.log(`[harness] ${name} state: ${state}`);
  } catch {}
}

const headed = process.argv.includes("--headed");
const relay = await ensureRelay();
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/?relay=${encodeURIComponent(RELAY_URL)}`;
console.log(`[harness] host: ${base}`);

const browser = await chromium.launch({ headless: !headed });
const failures = [];
let host, joiner;
try {
  const context = await browser.newContext();
  host = await openPage(context, "host", base);

  const joinUrl = await host
    .waitForFunction(() => globalThis.__demo?.joinUrl, { timeout: TIMEOUT })
    .then((h) => h.jsonValue());
  console.log(`[harness] join url ready (QR payload): ${joinUrl}`);

  joiner = await openPage(context, "join", joinUrl);
  for (const [name, page] of [["host", host], ["join", joiner]]) {
    await page.waitForFunction(
      () => ["connected", "live"].includes(globalThis.__demo?.state),
      { timeout: TIMEOUT },
    );
    console.log(`[harness] ${name} connected`);
  }

  // Live migration onto the data channel.
  for (const [name, page] of [["host", host], ["join", joiner]]) {
    await page.waitForFunction(() => globalThis.__demo?.path === "direct", {
      timeout: TIMEOUT,
    });
    console.log(
      `[harness] ${name} migrated: ${await page.evaluate(
        () => `${globalThis.__demo.path} rtt=${globalThis.__demo.rttUs}us`,
      )}`,
    );
  }

  // Pings mirror both ways (post-migration).
  await host.click("#view", { position: { x: 100, y: 100 } });
  await joiner.waitForFunction(() => globalThis.__demo?.remotePings >= 1, {
    timeout: TIMEOUT,
  });
  console.log("[harness] host->join ping mirrored");
  await joiner.click("#view", { position: { x: 150, y: 150 } });
  await host.waitForFunction(() => globalThis.__demo?.remotePings >= 1, {
    timeout: TIMEOUT,
  });
  console.log("[harness] join->host ping mirrored");

  // File transfer both ways (stock iroh-blobs under the hood): 2MiB of
  // pseudorandom bytes, host -> joiner, then joiner -> host. "done" on
  // the receiver implies the bao verification passed; the sender's
  // "done" is the receiver's ack.
  const payload = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 2654435761) & 0xff;
  const fileDone = (name) => (page) =>
    page.waitForFunction(
      (n) =>
        globalThis.__demo.transfers.some(
          (t) => t.name === n && t.state === "done" && t.dir === "down" && t.bytes === t.size,
        ),
      name,
      { timeout: 60_000 },
    );
  const ackDone = (name) => (page) =>
    page.waitForFunction(
      (n) => globalThis.__demo.transfers.some((t) => t.name === n && t.state === "done" && t.dir === "up"),
      name,
      { timeout: 60_000 },
    );
  await host.setInputFiles("#file", {
    name: "host.bin",
    mimeType: "application/octet-stream",
    buffer: payload,
  });
  await fileDone("host.bin")(joiner);
  await ackDone("host.bin")(host);
  console.log("[harness] file host->join transferred and verified");
  await joiner.setInputFiles("#file", {
    name: "join.bin",
    mimeType: "application/octet-stream",
    buffer: payload,
  });
  await fileDone("join.bin")(host);
  await ackDone("join.bin")(joiner);
  console.log("[harness] file join->host transferred and verified");

  // A third participant is turned away (single-pair sessions) — then
  // closed, so it cannot race the rejoin scenario below.
  const third = await openPage(context, "third", joinUrl);
  await third.waitForFunction(
    () => ["closed", "error"].includes(globalThis.__demo?.state),
    { timeout: TIMEOUT },
  );
  await third.close();
  console.log("[harness] third participant refused");

  // Rejoin: the host reloads mid-session. Its identity persists
  // (sessionStorage secret + fragment), the joiner detects the loss
  // within the idle-timeout bound and its guest redials until the
  // re-hosted session accepts.
  const hostIdBefore = new URLSearchParams(new URL(joinUrl).hash.slice(1)).get("j");
  const joinPingsBefore = await joiner.evaluate(() => globalThis.__demo.remotePings);
  await host.reload();
  await joiner.waitForFunction(() => globalThis.__demo?.state === "closed", {
    timeout: 25_000,
  });
  console.log("[harness] joiner saw peer leave");
  const rehostUrl = await host
    .waitForFunction(() => globalThis.__demo?.joinUrl, { timeout: TIMEOUT })
    .then((h) => h.jsonValue());
  const hostIdAfter = new URLSearchParams(new URL(rehostUrl).hash.slice(1)).get("j");
  if (hostIdAfter !== hostIdBefore) {
    throw new Error(`host identity changed across reload: ${hostIdBefore} -> ${hostIdAfter}`);
  }
  console.log("[harness] host re-hosted with the same identity");
  await joiner.waitForFunction(
    () => ["connected", "live"].includes(globalThis.__demo?.state),
    { timeout: TIMEOUT },
  );
  console.log("[harness] joiner reconnected");
  for (const [name, page] of [["host", host], ["join", joiner]]) {
    await page.waitForFunction(() => globalThis.__demo?.path === "direct", {
      timeout: TIMEOUT,
    });
  }
  console.log("[harness] re-migrated to direct");
  await host.click("#view", { position: { x: 90, y: 90 } });
  await joiner.waitForFunction(
    (before) => globalThis.__demo?.remotePings > before,
    joinPingsBefore,
    { timeout: TIMEOUT },
  );
  console.log("[harness] ping mirrored after rejoin");
} catch (err) {
  failures.push(String(err));
  if (host) await dumpState("host", host);
  if (joiner) await dumpState("join", joiner);
} finally {
  await browser.close();
  server.close();
  relay?.kill();
}

if (failures.length) {
  console.error(`[harness] FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("[harness] PASS");
process.exit(0);
