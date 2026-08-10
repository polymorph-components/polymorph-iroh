# `host-deltic` — the deltic host: the endpoint surface on stock Deno

The endpoint component runtime-linked under
[deltic](https://github.com/lann/deltic): no transpile step, no generated
tree, no engine flag. This is the JS-host leg of the endpoint surface
that issue #10 blocks under jco — the detached pump task holding
in-flight relay imports across export calls is exactly the shape deltic's
scheduler serves — running today, side by side with the jco spike legs
and the drivers held ready for jco's fix.

The sibling repositories' own deltic host modules supply the non-WASI
imports, from the same pinned checkouts the jco leg maps its modules
from:

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

deltic is pinned to ONE release tag repo-wide, cross-checked at run time
by `fetch-translator.ts`:

- `deno.json` — import-map URLs
  (`raw.githubusercontent.com/lann/deltic/<tag>/…`) for
  `@deltic/runtime/{embedder,shim}` and `@deltic/wasi-shims`;
  `deno.lock` carries integrity hashes, enforced with `--frozen`. The
  sibling host modules map to their `.deps` checkouts (pinned by
  `scripts/setup.sh`), and the npm mappings (`node-datachannel`,
  `werift`) serve the webrtc module's bare specifiers, which resolve
  against this config as the entry import map.
- `fetch-translator.ts` — `TAG` + `TRANSLATOR_SHA256` for the
  `deltic-translator-shim.wasm` release asset (cached under
  `target/deltic/<tag>/`).
- `experiments/iroh-relay-ws/host/deno.json` — the upstream-iroh spikes'
  shared config (one import map for all three experiments), plus the
  translate-CLI URL in `experiments/ping-demo/build.sh`; both must carry
  the same tag, and `fetch-translator.ts` refuses to run on drift.

To bump: update the tag in all of the above and the sha256 from the
release's `SHA256SUMS`, delete both `deno.lock` files, re-run
`just deltic-setup` and `deno install --allow-scripts=npm:node-datachannel`
in `experiments/iroh-relay-ws/host/` to regenerate them, and commit the
diff.

## Module identity

deltic's wasi-shims and the sibling deltic host modules import
`@deltic/runtime/embedder` by bare specifier internally; `deno.json`
maps that specifier once for the whole module graph, so there is exactly
one `WitError`/`Stream` module instance and `instanceof` holds across
every boundary.
