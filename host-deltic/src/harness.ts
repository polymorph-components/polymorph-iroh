// The exam harness: relay lifecycle, artifact translation, and one typed
// handle on `polymorph:iroh/endpoint@0.1.0` per endpoint instance.
//
// Everything here is host wiring; the scenarios in `run-endpoint.ts` carry
// the verdicts. `bindEndpoint(...)` mirrors the jco host's retired
// `iroh.Endpoint.bind(...)` driving shape over `instantiate` + the deltic
// embedder facade.
//
// MODULE-IDENTITY CONSTRAINT: deltic's wasi-shims and the sibling host
// modules import `@deltic/runtime/embedder` by bare specifier internally;
// this package's `deno.json` maps that specifier ONCE for the whole module
// graph, so there is exactly one `WitError`/`Stream` module instance and
// `instanceof` holds across every boundary.

import { defaultTranslator } from "@deltic/translator";
import type { ComponentArtifacts } from "@deltic/runtime/embedder";
import { instantiate, WitError } from "@deltic/runtime/embedder";
import { wasiShims } from "@deltic/wasi-shims";
import { webcryptoImports } from "@polymorph/webcrypto-deltic";
import { websocketImports } from "../../.deps/websocket/js/deltic/websocket.ts";
import { webrtcImports } from "../../.deps/webrtc/deltic-impl/src/webrtc.ts";
import { socketsImports } from "./sockets.ts";
import type {
  BindConfig,
  Endpoint,
  IdentityGenerateExports,
  IrohEndpointExports,
} from "./types.ts";

// This file sits at host-deltic/src/harness.ts, so the repo root is two
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

export const IROH_ENDPOINT_INTERFACE = "polymorph:iroh/endpoint@0.1.0";
export const IDENTITY_GENERATE_INTERFACE = "polymorph:iroh/identity-generate@0.1.0";

// --- artifact ---------------------------------------------------------------

let cachedArtifacts: ComponentArtifacts | undefined;

async function exists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * Translate the endpoint component once. The plan and adapters are reused
 * across every `instantiate` in the run: two endpoint *instances* are two
 * separate component instances over the same immutable artifacts.
 *
 * The translator is `@deltic/translator`'s packaged asset — the same
 * pinned release as the runtime, loaded through the module graph
 * (permission-free on Deno), so there is no fetch step and no
 * plan-format skew to guard against.
 */
export async function loadArtifacts(): Promise<ComponentArtifacts> {
  if (cachedArtifacts) return cachedArtifacts;
  if (!await exists(ENDPOINT_WASM)) {
    throw new Error(
      `endpoint component not found at ${ENDPOINT_WASM} — build it with ` +
        "`just build-components`.",
    );
  }
  const bytes = await Deno.readFile(ENDPOINT_WASM);
  const translator = await defaultTranslator();
  const { plan, adapters } = translator.translate(bytes);
  cachedArtifacts = { plan, componentBytes: bytes, adapters };
  return cachedArtifacts;
}

// --- instances --------------------------------------------------------------

export interface EndpointInstanceOptions {
  /** Label used in log lines (`server`, `client`, …). */
  readonly label: string;
  /** Extra environment for the guest's `wasi:cli/environment`. */
  readonly env?: Record<string, string>;
}

export interface EndpointInstance {
  readonly label: string;
  readonly api: IrohEndpointExports;
  readonly identityGenerate: IdentityGenerateExports;
  /** Whatever the guest wrote to stdout/stderr through the WASI shims. */
  stdout(): string;
  stderr(): string;
}

/**
 * Stand up one component instance of the endpoint, with the sibling deltic
 * host modules supplying every non-WASI import.
 *
 * Import fragments are built FRESH per instance: the host modules' resource
 * classes carry per-instance registry identity, and sharing one record
 * across two instantiations would alias two guests onto one table.
 */
export async function newEndpointInstance(
  options: EndpointInstanceOptions,
): Promise<EndpointInstance> {
  const artifacts = await loadArtifacts();
  const shims = wasiShims({
    cli: {
      args: [`iroh-endpoint-${options.label}`],
      env: { ...options.env },
      passthrough: Deno.env.get("EXAM_GUEST_LOGS") === "1",
    },
  });
  const imports = {
    ...shims,
    ...webcryptoImports(),
    ...websocketImports(),
    ...webrtcImports(),
    ...socketsImports(),
  };
  const instance = await instantiate(artifacts, imports);
  const api = instance.exports[IROH_ENDPOINT_INTERFACE] as IrohEndpointExports;
  const identityGenerate = instance
    .exports[IDENTITY_GENERATE_INTERFACE] as IdentityGenerateExports;
  if (!api || typeof api.Endpoint?.bind !== "function") {
    throw new Error(
      `export "${IROH_ENDPOINT_INTERFACE}" missing or shapeless; plan exports: ` +
        artifacts.plan.exports.map((e: { name: string }) => e.name).join(", "),
    );
  }
  if (typeof identityGenerate?.generate !== "function") {
    throw new Error(`export "${IDENTITY_GENERATE_INTERFACE}" missing or shapeless`);
  }
  return {
    label: options.label,
    api,
    identityGenerate,
    stdout: () => shims.captured.stdoutText(),
    stderr: () => shims.captured.stderrText(),
  };
}

/**
 * `Endpoint.bind`, with the retired jco host's driving shape: generate
 * an identity, construct `endpoint-options` around it, populate the
 * setters, bind. The options resource is consumed by `bind`; the
 * identity's borrow ends at the constructor, so it is dropped once the
 * endpoint is up.
 */
export async function bindEndpoint(
  instance: EndpointInstance,
  config: BindConfig,
): Promise<Endpoint> {
  const identity = await instance.identityGenerate.generate();
  const options = new instance.api.EndpointOptions(identity);
  for (const alpn of config.alpns) await options.addAlpn(alpn);
  if (config.relayUrl !== undefined) await options.relayUrl(config.relayUrl);
  if (config.udpBindAddr !== undefined) await options.udpBindAddr(config.udpBindAddr);
  if (config.webrtc) await options.webrtc(true);
  const endpoint = await instance.api.Endpoint.bind(options);
  identity.drop();
  return endpoint;
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

// --- small helpers ----------------------------------------------------------

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Endpoint ids are 64 hex chars; log them short (they are public keys). */
export const shortId = (bytes: Uint8Array): string => `${hex(bytes).slice(0, 12)}…`;

export const utf8 = new TextEncoder();
export const fromUtf8 = new TextDecoder();

/** Reject after `ms`, so a wedged scenario names itself instead of hanging. */
export function deadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms);
  });
  return Promise.race([promise, bomb]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

/** Render a rejection, unwrapping the branded WIT error payload. */
export function describeError(err: unknown): string {
  if (err instanceof WitError) {
    const p = err.payload as { tag?: string; val?: unknown } | undefined;
    return `WitError ${p?.tag ?? "?"}${p?.val === undefined ? "" : `(${String(p.val)})`}`;
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
