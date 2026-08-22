// The polyengine module-identity assert (host-polyengine/README.md "Module
// identity"): the run-endpoint graph must contain exactly ONE
// @polyengine/runtime version and ZERO raw.githubusercontent modules.
//
// The failure this guards (seen live before the sibling pins converged on
// one polyengine release): a sibling host module's own
// package-shaped deno.json mapped @polyengine/runtime/embedder to a raw
// pinned-tag URL, so the graph carried TWO embedder module instances and
// `instanceof ComponentException` silently stopped holding across that sibling's
// boundary. Config greps can't see this — only the resolved graph can —
// so the exam pipes `deno info --json` through this assert.
//
//   deno info --json --config host-polyengine/deno.json \
//       host-polyengine/src/run-endpoint.ts | deno run scripts/polyengine-identity-gate.ts
const g = JSON.parse(await new Response(Deno.stdin.readable).text());
const raw = g.modules.filter((m: { specifier: string }) =>
  m.specifier.includes("raw.githubusercontent")
);
const vers = new Set(
  g.modules
    .map((m: { specifier: string }) =>
      m.specifier.match(/jsr\.io\/@polyengine\/runtime\/([^/]+)\//)?.[1]
    )
    .filter(Boolean),
);
if (raw.length || vers.size !== 1) {
  console.error(
    `polyengine module identity violated: ${raw.length} raw-URL module(s), ` +
      `@polyengine/runtime versions=[${[...vers].join(", ")}] (want exactly one, no raw URLs)`,
  );
  for (const m of raw.slice(0, 5)) console.error(`  raw: ${m.specifier}`);
  Deno.exit(1);
}
console.log(`polyengine module identity: one runtime (${[...vers][0]}), no raw URLs`);
