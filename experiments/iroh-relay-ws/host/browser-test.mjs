// Playwright harness: runs the spike in a real Chromium and asserts the
// live relay→webrtc migration happened. Companion to run.ts (Deno path).
//
// - fetches the pinned deltic translator shim (host-deltic/fetch-translator.ts)
//   and bundles the page driver with `deno bundle --platform browser`,
// - serves the repository root over HTTP (the guest/translator fetches
//   resolve there, and COOP/COEP headers buy 5us timers for the guest's
//   RTT measurements),
// - reuses a running iroh-relay on 127.0.0.1:3340 or starts one,
// - launches Chromium (JSPI is stable there; a fallback relaunch passes
//   the V8 flag for older builds), loads browser.html, mirrors the
//   console, and asserts the migration + phase-2-over-ip lines.
//
// Usage: node browser-test.mjs [--headed]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HOST_DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PAGE_PATH = "/experiments/iroh-relay-ws/host/browser.html";
const RELAY_BIN = join(ROOT, ".deps/iroh/target/release/iroh-relay");
const TIMEOUT_MS = 90_000;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

const run = promisify(execFile);

/** Fetch (cached) the pinned translator shim; return its URL path under ROOT. */
async function fetchTranslator() {
  const { stdout } = await run("deno", [
    "run",
    "--config",
    join(ROOT, "host-deltic/deno.json"),
    "--frozen",
    `--allow-read=${ROOT}`,
    `--allow-write=${join(ROOT, "target/deltic")}`,
    "--allow-net=github.com,objects.githubusercontent.com,release-assets.githubusercontent.com",
    join(ROOT, "host-deltic/fetch-translator.ts"),
  ]);
  const path = stdout.trim();
  return `/${relative(ROOT, path).split("\\").join("/")}`;
}

async function bundleEntry() {
  await run("deno", [
    "bundle",
    "--platform",
    "browser",
    "--external",
    "node-datachannel/polyfill",
    "--external",
    "werift",
    "-o",
    join(HOST_DIR, "dist/browser-entry.js"),
    join(HOST_DIR, "browser-entry.ts"),
  ], { cwd: HOST_DIR });
}

async function relayUp() {
  try {
    await fetch("http://127.0.0.1:3340", { signal: AbortSignal.timeout(1000) });
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
  throw new Error("relay server did not come up on 127.0.0.1:3340");
}

function serveRoot() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    try {
      const body = await readFile(join(ROOT, path));
      res.writeHead(200, {
        "content-type": MIME[extname(path)] ?? "application/octet-stream",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

async function runPage(browser, url, lines) {
  const page = await browser.newPage();
  page.on("console", (msg) => {
    const text = msg.text();
    lines.push(text);
    console.log(`[browser] ${text}`);
  });
  page.on("pageerror", (err) => {
    lines.push(`pageerror: ${err.message}`);
    console.error(`[browser] pageerror: ${err.message}`);
  });
  const jspi = await page.evaluate(
    () => typeof WebAssembly.Suspending === "function",
  );
  if (!jspi) return { jspi: false };
  await page.goto(url);
  await page.waitForFunction(() => globalThis.__spike, { timeout: TIMEOUT_MS });
  return { jspi: true, result: await page.evaluate(() => globalThis.__spike) };
}

const headed = process.argv.includes("--headed");
console.log("[harness] fetching translator + bundling the page driver");
const translatorPath = await fetchTranslator();
await bundleEntry();
const relay = await ensureRelay();
const server = await serveRoot();
const url = `http://127.0.0.1:${server.address().port}${PAGE_PATH}?translator=${
  encodeURIComponent(translatorPath)
}`;
console.log(`[harness] serving ${url}`);

const lines = [];
let result;
let browser = await chromium.launch({ headless: !headed });
try {
  let out = await runPage(browser, url, lines);
  if (!out.jspi) {
    console.log("[harness] JSPI not available; relaunching with the V8 flag");
    await browser.close();
    browser = await chromium.launch({
      headless: !headed,
      args: ["--js-flags=--experimental-wasm-jspi"],
    });
    out = await runPage(browser, url, lines);
    if (!out.jspi) throw new Error("JSPI unavailable in this Chromium even with the flag");
  }
  result = out.result;
} finally {
  await browser.close();
  server.close();
  relay?.kill();
}

const migrated = lines.find((l) => l.includes("connection migrated off the relay"));
const phase2 = lines.find((l) => /echo rtt \[phase 2\] path=ip/.test(l));
const failures = [];
if (!result?.ok) failures.push(`driver: ${result?.error ?? "no result"}`);
if (!migrated) failures.push("no migration line");
if (!phase2) failures.push("no phase-2-over-ip line");

if (failures.length) {
  console.error(`[harness] FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`[harness] PASS: ${migrated}`);
console.log(`[harness] PASS: ${phase2}`);
process.exit(0);
