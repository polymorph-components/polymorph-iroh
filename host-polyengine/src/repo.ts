// Repo-internal exam machinery, publish-excluded (deno.json
// `publish.exclude`): paths into this repository's build outputs and the
// pinned upstream relay binary. The published package carries none of
// this — consumers use the packaged endpoint component (or pass their own
// bytes) and bring their own relay.

// This file sits at host-polyengine/src/repo.ts, so the repo root is two
// levels up.
const ROOT = new URL("../../", import.meta.url);

/** The endpoint component, built by `just build-components`. */
export const ENDPOINT_WASM =
  new URL("target/wasm32-wasip2/release/iroh_endpoint.wasm", ROOT).pathname;

/** The stock upstream relay binary, pinned and installed onto PATH by
 * `scripts/setup.sh`. */
export const RELAY_BIN = "iroh-relay";
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
  /**
   * Whether this run spawned the relay process. An adopted relay
   * (`false`) is somebody else's: `stop()` does nothing, so a scenario
   * that needs the relay to actually go away must skip.
   */
  readonly owned: boolean;
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
 * racing a second binder. Each call spawns its own process, so a stopped
 * relay is restarted by calling this again.
 */
export async function startRelay(): Promise<Relay> {
  if (await portOpen(RELAY_PORT)) {
    console.error(`relay: adopting an already-listening 127.0.0.1:${RELAY_PORT}`);
    return { url: RELAY_URL, owned: false, stop: () => Promise.resolve() };
  }
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(RELAY_BIN, {
      args: ["--dev"],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(
        `\`${RELAY_BIN}\` not found on PATH — install it with \`scripts/setup.sh\`.`,
      );
    }
    throw e;
  }
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
        owned: true,
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
