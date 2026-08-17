// Repo-internal exam machinery, publish-excluded (deno.json
// `publish.exclude`): paths into this repository's build outputs and the
// locally built upstream relay. The published package carries none of
// this — consumers use the packaged endpoint component (or pass their own
// bytes) and bring their own relay.

// This file sits at host-deltic/src/repo.ts, so the repo root is two
// levels up.
const ROOT = new URL("../../", import.meta.url);

/** The endpoint component, built by `just build-components`. */
export const ENDPOINT_WASM =
  new URL("target/wasm32-wasip2/release/iroh_endpoint.wasm", ROOT).pathname;

/** The stock upstream relay, built by `just relay-build`. */
export const RELAY_BIN =
  new URL(".deps/iroh/target/release/iroh-relay", ROOT).pathname;
/** `iroh-relay --dev` serves ws on this address. */
export const RELAY_PORT = 3340;
export const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`;

async function exists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

let cachedBytes: Uint8Array | undefined;

/**
 * The freshly built endpoint component's bytes (read once). The exam runs
 * against this tree's build rather than the packaged asset, so a code
 * change is exercised without regenerating the embed.
 */
export async function endpointComponentBytes(): Promise<Uint8Array> {
  if (cachedBytes) return cachedBytes;
  if (!await exists(ENDPOINT_WASM)) {
    throw new Error(
      `endpoint component not found at ${ENDPOINT_WASM} — build it with ` +
        "`just build-components`.",
    );
  }
  cachedBytes = await Deno.readFile(ENDPOINT_WASM);
  return cachedBytes;
}

// --- relay ------------------------------------------------------------------

export interface Relay {
  readonly url: string;
  stop(): Promise<void>;
}

async function portOpen(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn `iroh-relay --dev` (ws on 127.0.0.1:3340) and wait for it to accept.
 *
 * If something is already listening on the port we adopt it rather than
 * racing a second binder.
 */
export async function startRelay(): Promise<Relay> {
  if (await portOpen(RELAY_PORT)) {
    console.error(`relay: adopting an already-listening 127.0.0.1:${RELAY_PORT}`);
    return { url: RELAY_URL, stop: () => Promise.resolve() };
  }
  if (!await exists(RELAY_BIN)) {
    throw new Error(
      `iroh-relay not found at ${RELAY_BIN} — build it with \`just relay-build\`.`,
    );
  }
  const child = new Deno.Command(RELAY_BIN, {
    args: ["--dev"],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // Drain the pipes so the relay never blocks on a full stdio buffer, and
  // so `stop()` can close them without an unresolved-read sanitizer hit.
  const sink = (r: ReadableStream<Uint8Array>) =>
    r.pipeTo(new WritableStream({ write() {} })).catch(() => {});
  const drained = Promise.all([sink(child.stdout), sink(child.stderr)]);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await portOpen(RELAY_PORT)) {
      console.error(`relay: iroh-relay --dev listening on ${RELAY_URL} (pid ${child.pid})`);
      return {
        url: RELAY_URL,
        stop: async () => {
          try {
            child.kill("SIGTERM");
          } catch { /* already gone */ }
          await child.status;
          await drained;
        },
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    child.kill("SIGKILL");
  } catch { /* ignore */ }
  await child.status;
  await drained;
  throw new Error(`iroh-relay did not listen on ${RELAY_PORT} within 15s`);
}
