# `host-polyengine` — the polyengine host: the endpoint surface on stock Deno

The endpoint component runtime-linked under
[polyengine](https://github.com/polymorph-components/polyengine): no transpile step, no generated
tree, no engine flag. This is the JS-host leg of the endpoint surface
that issue #10 blocked under jco — the detached pump task holding
in-flight relay imports across export calls is exactly the shape polyengine's
scheduler serves. The jco host (`host-jco/`) ran this repository's demos
alongside this exam until it retired in favor of this host (see git
history); this is now the repository's only JS host.

The sibling repositories' own polyengine host modules supply the non-WASI
imports, consumed from JSR by caret constraint (the lockfile pins the
resolved versions):

| Import | Module |
| --- | --- |
| `polymorph:websocket/connections` | `jsr:@polymorph/websocket` |
| `polymorph:webrtc-datachannels/connections` | `jsr:@polymorph/webrtc-datachannels` |
| `polymorph:webcrypto/*` | `jsr:@polymorph/webcrypto` |
| `wasi:sockets/types` | `src/sockets.ts` — fail-on-call stubs (the browser profile; see its header) |
| everything WASI | polyengine's `@polyengine/wasi` package |

## The exam

```sh
just exam-polyengine
```

builds the endpoint component and the stock relay, installs the leg's
pinned module graph + the `node-datachannel` addon
(`just polyengine-setup`, idempotent), fetches the sha256-pinned translator
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

polyengine and the sibling host modules arrive from JSR under caret
constraints on one minor line (`jsr:@polyengine/*@^0.4.0`,
`jsr:@polymorph/*@^0.4.0`); `deno.lock` pins the resolved versions and
carries integrity, enforced with `--frozen`. `@polyengine/translator` ships
the translator wasm for the same commit as the runtime, so the
plan-format coupling between runtime and translator is self-consistent
inside each graph by construction — there is no separate asset pin and
no fetch step. `minimumDependencyAge` exempts `jsr:@polyengine/*` and
`jsr:@polymorph/*` from Deno's default 24-hour supply-chain gate so
same-day releases resolve; everything else keeps the default.
`experiments/iroh-relay-ws/host/deno.json` (the upstream-iroh spikes'
shared config) exact-pins the same polyengine packages; the `exam-polyengine`
recipe asserts both `deno.lock`s resolve to one polyengine version.

To bump: adjust the constraints (a new minor line) or just delete the
`deno.lock` files (within the line), re-run `just polyengine-setup` and
`deno install --allow-scripts=npm:node-datachannel` in
`experiments/iroh-relay-ws/host/` to regenerate them, and commit the
diff.

## Module identity

polyengine's wasi package and the sibling host modules import
`@polyengine/runtime/embedder` by bare specifier internally, each resolved
through its own package manifest. Identity rests on every manifest in
the graph carrying a constraint the resolver can satisfy with ONE
`@polyengine/runtime` version, so it dedupes to one
`ComponentException`/`Stream` module instance — caret constraints on
one minor line guarantee that; an exact pin outside every other
manifest's range (or a raw-URL embedder module) splits the graph, and
`instanceof ComponentException` silently stops holding across that
boundary. Two gates in `just exam-polyengine` keep it true: the lock check
(this repo's `deno.lock`s resolve to one polyengine version) and
`scripts/polyengine-identity-gate.ts` (the RESOLVED run-endpoint graph
carries exactly one `@polyengine/runtime` and no raw URLs).
