// The deltic module-identity assert (host-deltic/README.md "Module
// identity"): the run-endpoint graph must contain exactly ONE
// @deltic/runtime version and ZERO raw.githubusercontent modules.
//
// The failure this guards (seen live before the .deps pins converged on
// JSR-consuming sibling revisions): a sibling host module's own
// package-shaped deno.json mapped @deltic/runtime/embedder to a raw
// pinned-tag URL, so the graph carried TWO embedder module instances and
// `instanceof WitError` silently stopped holding across that sibling's
// boundary. Config greps can't see this — only the resolved graph can —
// so the exam pipes `deno info --json` through this assert.
//
//   deno info --json --config host-deltic/deno.json \
//       host-deltic/src/run-endpoint.ts | deno run scripts/deltic-identity-gate.ts
const g = JSON.parse(await new Response(Deno.stdin.readable).text());
const raw = g.modules.filter((m: { specifier: string }) =>
  m.specifier.includes("raw.githubusercontent")
);
const vers = new Set(
  g.modules
    .map((m: { specifier: string }) =>
      m.specifier.match(/jsr\.io\/@deltic\/runtime\/([^/]+)\//)?.[1]
    )
    .filter(Boolean),
);
if (raw.length || vers.size !== 1) {
  console.error(
    `deltic module identity violated: ${raw.length} raw-URL module(s), ` +
      `@deltic/runtime versions=[${[...vers].join(", ")}] (want exactly one, no raw URLs)`,
  );
  for (const m of raw.slice(0, 5)) console.error(`  raw: ${m.specifier}`);
  Deno.exit(1);
}
console.log(`deltic module identity: one runtime (${[...vers][0]}), no raw URLs`);
