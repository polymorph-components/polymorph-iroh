// Build-time translation (deltic embedder-api A4): component in, envelope
// out. The translator is `@deltic/translator`'s packaged asset — the same
// pinned release as the runtime, so the envelope's plan format matches
// what the pages' `artifactsFromEnvelope` expects by construction.
//
// Used by ping-demo's build.sh and the spikes' browser harnesses (their
// pages fetch component + envelope; no translator ships to a browser).
//
//   deno run --allow-read --allow-write --config <this dir>/deno.json \
//       translate.ts <component.wasm> <out.plan.json>

import { defaultTranslator } from "@deltic/translator";

const [input, output] = Deno.args;
if (!input || !output) {
  console.error("usage: translate.ts <component.wasm> <out.plan.json>");
  Deno.exit(2);
}
const translator = await defaultTranslator();
const envelope = translator.translateRaw(await Deno.readFile(input));
await Deno.writeTextFile(output, envelope);
console.error(`translated ${input} -> ${output} (${envelope.length} bytes)`);
