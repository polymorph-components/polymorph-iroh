// Fetch (and cache) the deltic translator-shim wasm for the pinned release.
//
// deltic is a runtime linker: components are translated by a wasm build of
// its translator, shipped as a release asset so consumers need no extra
// Rust build. This script downloads that asset once into target/deltic/,
// verifies it against the pinned sha256, and prints the cached path on
// stdout (the `exam-deltic` recipe captures it and exports it as
// `DELTIC_TRANSLATOR`).
//
// THE PIN lives here (TAG + TRANSLATOR_SHA256) and in the sibling
// deno.json's import-map URLs. `assertPinConsistency` checks the latter
// against TAG and fails loud on drift.
//
// Bumping: update TAG here and in deno.json, update TRANSLATOR_SHA256 from
// the release's SHA256SUMS, delete deno.lock, and re-run
// `deno install --allow-scripts=npm:node-datachannel` in this directory to
// regenerate it (commit the diff).

const TAG = "pre-eb3f8d0";
const TRANSLATOR_SHA256 =
  "6d02b363785593595a789d083cda0aebb1de790726718ccf543198354fa3870c";
const ASSET = "deltic-translator-shim.wasm";

const HERE = new URL(".", import.meta.url);
const REPO_ROOT = new URL("../", HERE);
const CACHE_DIR = new URL(`target/deltic/${TAG}/`, REPO_ROOT);
const CACHED = new URL(ASSET, CACHE_DIR);
const RELEASE_URL =
  `https://github.com/lann/deltic/releases/download/${TAG}/${ASSET}`;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The one-pin-everywhere gate: every raw.githubusercontent deltic URL in
 * the sibling import map — and in the experiments' shared config and the
 * ping demo's build-time translate step, which ride the same release —
 * must reference TAG. */
async function assertPinConsistency(): Promise<void> {
  const pinned = [
    new URL("deno.json", HERE),
    new URL("../experiments/iroh-relay-ws/host/deno.json", HERE),
    new URL("../experiments/ping-demo/build.sh", HERE),
  ];
  for (const fileUrl of pinned) {
    const text = await Deno.readTextFile(fileUrl);
    const urls = text.match(
      /https:\/\/raw\.githubusercontent\.com\/lann\/deltic[^"\s]+/g,
    ) ?? [];
    if (fileUrl.pathname.endsWith("deno.json") && urls.length === 0) {
      throw new Error(`${fileUrl.pathname}: no pinned deltic URLs found`);
    }
    for (const url of urls) {
      if (!url.includes(`/lann/deltic/${TAG}/`)) {
        throw new Error(
          `pin drift: ${fileUrl.pathname} pins ${url}\n` +
            `but fetch-translator.ts pins ${TAG}`,
        );
      }
    }
  }
}

async function main() {
  await assertPinConsistency();

  try {
    const cached = await Deno.readFile(CACHED);
    if (await sha256Hex(cached) === TRANSLATOR_SHA256) {
      console.log(CACHED.pathname);
      return;
    }
    console.error(`cached ${ASSET} has a stale digest; re-fetching`);
  } catch {
    // not cached yet
  }

  console.error(`fetching ${RELEASE_URL} …`);
  const resp = await fetch(RELEASE_URL);
  if (!resp.ok) {
    throw new Error(`GET ${RELEASE_URL}: ${resp.status} ${resp.statusText}`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const got = await sha256Hex(bytes);
  if (got !== TRANSLATOR_SHA256) {
    throw new Error(
      `sha256 mismatch for ${ASSET}@${TAG}:\n  want ${TRANSLATOR_SHA256}\n  got  ${got}`,
    );
  }
  await Deno.mkdir(CACHE_DIR, { recursive: true });
  await Deno.writeFile(CACHED, bytes);
  console.log(CACHED.pathname);
}

await main();
