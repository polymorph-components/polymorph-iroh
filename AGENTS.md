# AGENTS.md

Guidance for automated agents (and humans) working in this repository.

## What this repository is

`component-iroh`: a portable implementation of [iroh](https://iroh.computer)
as WebAssembly components — the same endpoint logic running in browsers, on
personal devices, and on cloud providers. It is the consuming project of the
sibling family
([`polymorph:webcrypto`](https://github.com/polymorph-components/polymorph-webcrypto),
[`polymorph:webrtc-datachannels`](https://github.com/polymorph-components/polymorph-webrtc-datachannels),
[`polymorph:websocket`](https://github.com/polymorph-components/polymorph-websocket),
[`polymorph-test`](https://github.com/polymorph-components/polymorph-test)) and mirrors
their architecture and conventions — prefer clarity and correctness over
features, and keep every deployment target behaviourally in sync
(cross-implementation conformance is the gate once it exists). See
[`README.md`](README.md) for the design.

The repository is currently a **design seed**: README plus issues. When
adding the first code, copy the conventions from the siblings rather than
inventing new ones — root `justfile` as the single entry point with
component-scoped module justfiles, `scripts/setup.sh` for idempotent
dependency setup, CI running the same `just` recipes, conformance driven by
a shared guest with per-target adapters and a `targets.toml` declaring
target facts.

Before designing WIT or touching async/stream plumbing, consult
[`lann/wasm-component-starter`](https://github.com/lann/wasm-component-starter)
(especially `OUTLINE.md`) — treat it as a living knowledge base and re-read
it rather than relying on a cached summary.

## Design invariants

These come from the README's rulings; changing one is a design decision to
record (and usually an issue to resolve), not a refactor.

- **QUIC runs end-to-end on every path.** The browser leg tunnels QUIC
  through unreliable, unordered WebRTC data channels; it does not use SCTP
  streams as the connection. Do not fork the endpoint layer per transport.
- **Wire-format compatibility with upstream iroh on UDP paths** (discovery
  records, relay protocol, `n0_nat_traversal`, ALPN dispatch) is a feature,
  not an accident. A change that breaks it needs an explicit ruling.
- **The crypto split**: `polymorph:webcrypto` serves identity — key generation,
  public-key export, and signing (discovery records, relay auth, the TLS
  CertificateVerify). Everything else — peer verification, key agreement,
  the key-derivation ladder, transcript hashing, and per-packet record
  protection — runs in-guest through `polymorph:tls` (the #5 ruling; the
  README's crypto-split section is the authoritative statement). Do not
  move per-packet operations across the component boundary, and do not
  move identity keys into guest memory on platforms whose host can hold
  them.
- **Sans-I/O core, injected edges.** The QUIC/endpoint core is sans-I/O;
  transports (`wasi:sockets` UDP, `polymorph:webrtc-datachannels`,
  `polymorph:websocket`), time, and crypto arrive through imports. No direct OS
  or engine dependencies in the core.
- **Shared WIT packages are dependencies, defined once upstream.** Sibling
  packages come in via `wit/deps` (symlinks for any package defined in this
  repository, vendored/versioned copies for the siblings, per their release
  practice). Never fork a sibling's package in-tree; a needed surface change
  is a PR to the sibling.
- **Anything browser-hosted must stay browser-compatible**: host-side JS
  uses only standard browser APIs (`crypto.subtle`, `RTCPeerConnection`,
  `WebSocket`); Deno (via `host-deltic/`) is just the current runner.
- **Divergence between targets is resolved, not accumulated.** Apply the
  webcrypto sibling's portability ladder in order: design it out; enhance
  the deficient implementation (never crypto, never key-material
  synthesis); narrow uniformly; record latitude at the definition site;
  isolate behind a gate or a declared optional target capability. A
  divergence with no artifact is a bug.
- **Performance claims are measured, not assumed.** The design accepts
  costs (handshake latency through the WIT boundary, QUIC-over-data-channel
  overhead) by budget; a change justified by performance carries its
  measurement.

## Check the rationale before implementing it

Requests arrive with a reason attached. The reason is a claim about the
code, and it can be false while the request still points at something real.
Establish that it holds before writing the change, and if it does not, say
so first. A contradiction turned up while researching is a result to
report, not an obstacle to route around. Separate what is wrong with the
code now from what the proposed remedy fixes — they are often both true of
*different* problems; name which property the change actually buys.

## WIT doc comments

Every WIT comment is a doc comment: bindings generators project it into
library documentation, so its audience is the package's *consumers*, not
this repository's contributors. Package-wide contracts live in a
`wit/README.md`, referenced by name from item docs — never restated in full
at a use site, never living only inside one item's doc. Basic usage first;
critical caveats (identity-key handling, what a verified connection does
and does not authenticate) never buried mid-paragraph behind mechanics. Use
Simplified Technical English as guidance: short sentences, active voice,
one instruction per sentence, consistent terms. No repository-internal
content (implementations, test harnesses, design history) on the package
surface.

## Code comments and docs

Code comments describe **what** something is or does, not the process by
which it was arrived at. Rationale like "we removed X because Y" belongs in
commit messages or PR descriptions. Comment what a reader could not
predict: an invariant, a hazard, a deliberate departure from the obvious
choice, a constraint imposed from outside the file — never a defence of the
presence of ordinary code. Answers to an objection belong where the
objection was raised (the pull request), not in source. Guards are the
exception: a test or assertion exists *because* of the failure it prevents,
so saying what it catches describes what it is.

Docs state invariants, not inventories. Never embed values a build or test
run computes; if a number matters, a gate asserts it.

## Sizing pull requests

Three factors, binding in order:

1. **Necessity.** Changes that cannot land separately without leaving
   `main` worse between them go in one PR, whatever that does to its size.
   Once conformance gates all targets against one behavior, a change to a
   shared surface is co-dependent across every target *by construction* —
   name the co-dependence in the description.
2. **Cohesion.** One decision per PR: a single ruling plus its
   consequences. "And also" is the tell that two PRs are sharing a branch.
3. **Review time.** Within what the first two allow, smaller is better —
   except that many *nearly identical* changes are one PR, not many,
   because near-identical diffs review sublinearly. The test is textual
   similarity of the diffs, not thematic similarity of the work.

## Tracking open findings in GitHub issues

Open findings and design decisions live in this repository's GitHub issue
tracker (`gh issue list`), not in a TODO file. Before starting work that
touches an area, search the open issues — some encode contract decisions
(e.g. the QUIC-over-data-channel mechanics, the relay protocol fidelity
question) that the change should resolve, not work around. Close issues
through PRs with closing-keyword lines (`Fixes #N`); when a PR resolves
only part of an issue, tick the resolved items and comment naming the PR.
File new issues for new findings rather than adding TODO comments or files.
