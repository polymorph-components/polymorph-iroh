// Shared host wiring for the upstream-iroh spikes under polyengine: artifact
// translation, the WASI import record, and the guest `run` entry point.
//
// Platform-portable core: byte loading (filesystem vs fetch) stays in the
// drivers (run.ts, browser-entry.ts); everything here uses standard
// globals only.
//
// MODULE-IDENTITY CONSTRAINT (host-polyengine/README.md "Module identity"):
// this application config maps `@polyengine/runtime/embedder` ONCE for the
// whole experiment module graph, so there is exactly one embedder instance
// and stateful handles (component instantiation, streams minted through it)
// stay portable across every boundary here. `ComponentException` and other
// vocabulary (thrown by sockets.ts) come from `@polyengine/protocol`
// instead (A22) — its copies are brand-checked, not `instanceof`-checked,
// so they don't depend on this constraint.

import type { ComponentArtifacts } from "@polyengine/runtime/embedder";
import { artifactsFromEnvelope, instantiate } from "@polyengine/runtime/embedder";
import type { Translator } from "@polyengine/runtime/shim";
import { wasi } from "@polyengine/wasi";
import { OutputStream } from "@polyengine/wasi/io";
import { syntheticNetImports } from "./sockets.ts";

/** Reconstitute build-time-translated artifacts (embedder-api A4). */
export function artifactsFrom(
  envelopeJson: string,
  componentBytes: Uint8Array,
): ComponentArtifacts {
  return artifactsFromEnvelope(envelopeJson, componentBytes);
}

/** A line-buffered console sink, tagged like the jco spike's shim was. */
function lineSink(tag: string, emit: (line: string) => void): (chunk: Uint8Array) => void {
  let buf = "";
  const decoder = new TextDecoder();
  return (chunk) => {
    buf += decoder.decode(chunk, { stream: true });
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      emit(`[${tag}] ${buf.slice(0, nl)}`);
      buf = buf.slice(nl + 1);
    }
  };
}

export interface GuestOptions {
  /** `wasi:cli/environment#get-arguments`. */
  args: string[];
  /** Guest environment (RUST_LOG and the demo's role variables ride here). */
  env: Record<string, string>;
}

/**
 * The full import record for the spike guests: polyengine's wasi()
 * baseline (whose A5 parking kernel serves poll/clock suspension), the
 * synthetic network fragment (sockets.ts), and stdio routed to the
 * console line-buffered.
 */
export function guestImports(options: GuestOptions): Record<string, unknown> {
  const stdout = new OutputStream(lineSink("guest-out", console.log));
  const stderr = new OutputStream(lineSink("guest-err", console.error));
  return {
    ...wasi({ cli: { args: options.args, env: options.env } }),
    ...syntheticNetImports(),
    "wasi:cli/stdout@0.2": { getStdout: (): OutputStream => stdout },
    "wasi:cli/stderr@0.2": { getStderr: (): OutputStream => stderr },
  };
}

/**
 * Instantiate the guest and invoke its `wasi:cli/run` export.
 *
 * `artifacts` is anything `instantiate` accepts (embedder-api A3): the
 * translated `ComponentArtifacts`, or `{ componentBytes, translator }`
 * with `@polyengine/translator`'s instance for in-process translation. jspi
 * mode is selected by the wasi package's own `suspending()` markers (the A5
 * kernel); no explicit option is needed.
 */
export async function runGuest(
  artifacts: ComponentArtifacts | {
    componentBytes: Uint8Array;
    translator: Uint8Array | Translator;
  },
  imports: Record<string, unknown>,
): Promise<void> {
  const instance = await instantiate(artifacts, imports);
  const runKey = Object.keys(instance.exports).find((k) => k.startsWith("wasi:cli/run@"));
  if (runKey === undefined) {
    throw new Error(
      `guest exports no wasi:cli/run interface (exports: ${
        Object.keys(instance.exports).join(", ")
      })`,
    );
  }
  await instance.exports[runKey].run();
}
