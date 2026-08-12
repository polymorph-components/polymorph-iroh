# `host-deltic` — the deltic host: the endpoint surface on stock Deno

The endpoint component runtime-linked under
[deltic](https://github.com/lann/deltic): no transpile step, no generated
tree, no engine flag. This is the JS-host leg of the endpoint surface
that issue #10 blocked under jco — the detached pump task holding
in-flight relay imports across export calls is exactly the shape deltic's
scheduler serves. The jco host (`host-jco/`) ran this repository's spike
demo alongside this exam until it retired in favor of this host (see
git history); this is now the repository's only JS host.

The sibling repositories' own deltic host modules supply the non-WASI
imports, from the same pinned checkouts `scripts/setup.sh` maintains:

| Import | Module |
| --- | --- |
| `polymorph:websocket/connections` | `.deps/websocket/js/deltic/websocket.ts` |
| `polymorph:webrtc-datachannels/connections` | `.deps/webrtc/deltic-impl/src/webrtc.ts` |
| `polymorph:webcrypto/*` | `.deps/webcrypto/js/deltic/src/mod.ts` |
| `wasi:sockets/types` | `src/sockets.ts` — fail-on-call stubs (the browser profile; see its header) |
| everything WASI | deltic's `wasi-shims` at the pinned release |

## The exam

```sh
just exam-deltic
```

builds the endpoint component and the stock relay, installs the leg's
pinned module graph + the `node-datachannel` addon
(`just deltic-setup`, idempotent), fetches the sha256-pinned translator
release asset, and runs `src/run-endpoint.ts` — five scenarios:

1. **bind + identity** — `identity-generate` → `new
   EndpointOptions(identity)` → `Endpoint.bind`; the Ed25519 identity
   minted through `polymorph:webcrypto`; three export calls against the
   live detached pump (the lann/jco#11 shape).
2. **relay echo** — two endpoint instances, QUIC handshake and an
   authenticated echo over a stock `iroh-relay --dev`.
3. **WebRTC upgrade** — a relay-dialed connection moves onto the data
   channel; `connection.path` reports the move.
4. **concurrency proof points** — 40 export calls against two live
   pumps (jco#11) and `accept` parked before the dial and woken by the
   pump (jco#13): issue #10's rows as passing assertions.
5. **teardown** — idempotent close, no guest traps, the relay reaped.

The exam retries the handshake-shaped scenarios a bounded number of
times: `endpoint/src/endpoint_impl.rs`'s shared state has a RefCell
borrow that crosses the `block_on`(webcrypto sign) yield point, so a
parked poller can trap the guest mid-handshake (`RefCell already
borrowed`); panic counts are reported per attempt. The hazard is the
guest's and is latent on every host.

## The pin

deltic arrives as exactly-pinned JSR prereleases:
`jsr:@deltic/{runtime,wasi-shims,translator}@0.1.0-pre.g<shorthash>`,
where the short hash names one upstream commit (the same hash as the
corresponding GitHub `pre-<shorthash>` release). `@deltic/translator`
ships the translator wasm for that same commit, so the plan-format
coupling between runtime and translator is self-consistent inside each
graph by construction — there is no separate asset pin and no fetch
step.

- `deno.json` — the versions in the import map; `deno.lock` carries
  integrity, enforced with `--frozen`. The sibling host modules map to
  their `.deps` checkouts (pinned by `scripts/setup.sh`), and the npm
  mappings (`node-datachannel`, `werift`) serve the webrtc module's
  bare specifiers, which resolve against this config as the entry
  import map. `minimumDependencyAge` exempts `jsr:@deltic/*` from
  Deno's default 24-hour supply-chain gate so same-day prereleases
  resolve; everything else keeps the default.
- `experiments/iroh-relay-ws/host/deno.json` — the upstream-iroh
  spikes' shared config, same versions by repo convention; the
  `exam-deltic` recipe asserts the two configs agree before running.

To bump: update the versions in both configs, delete both `deno.lock`
files, re-run `just deltic-setup` and
`deno install --allow-scripts=npm:node-datachannel` in
`experiments/iroh-relay-ws/host/` to regenerate them, and commit the
diff.

## Module identity

deltic's wasi-shims and the sibling deltic host modules import
`@deltic/runtime/embedder` by bare specifier internally. This config's
import map does NOT govern the sibling checkouts' files: a `.deps`
module under its own package-shaped `deno.json` (name + exports)
resolves its bare specifiers against THAT config — before the `.deps`
pins converged on JSR-consuming sibling revisions, the webcrypto module
silently rode a raw pinned-tag embedder while everything else used the
JSR one, and `instanceof ComponentException` did not hold across its boundary.
Identity therefore rests on every config in the graph — this one and
each pinned sibling's — naming the SAME `jsr:@deltic/*` version, so the
resolver dedupes to one `ComponentException`/`Stream` module instance. Two gates
in `just exam-deltic` keep it true: the pin grep (this repo's configs
agree) and `scripts/deltic-identity-gate.ts` (the RESOLVED run-endpoint
graph carries exactly one `@deltic/runtime` and no raw URLs). Bumping a
`.deps` pin to a sibling revision that consumes a different deltic
version trips the gate; converge the versions instead.
