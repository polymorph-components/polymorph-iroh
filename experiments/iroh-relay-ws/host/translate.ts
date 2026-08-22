// Build-time translation (polyengine embedder-api A4): component in, envelope
// out. The translator is `@polyengine/translator`'s packaged asset — the same
// pinned release as the runtime, so the envelope's plan format matches
// what the pages' `artifactsFromEnvelope` expects by construction.
//
// Used by ping-demo's build.sh and the spikes' browser harnesses (their
// pages fetch component + envelope; no translator ships to a browser).
//
//   deno run --allow-read --allow-write --config <this dir>/deno.json \
//       translate.ts <component.wasm> <out.plan.json>

import { dirname } from "node:path";
import { defaultTranslator } from "@polyengine/translator";

const [input, output] = Deno.args;
if (!input || !output) {
  console.error("usage: translate.ts <component.wasm> <out.plan.json>");
  Deno.exit(2);
}
const translator = await defaultTranslator();
const envelope = translator.translateRaw(await Deno.readFile(input));
// The output dir may not exist yet: the browser harnesses write the
// envelope into gitignored dist/ BEFORE `deno bundle` (the other dist/
// writer) runs, so on a fresh checkout this is the first creator.
await Deno.mkdir(dirname(output), { recursive: true });
await Deno.writeTextFile(output, envelope);
console.error(`translated ${input} -> ${output} (${envelope.length} bytes)`);
