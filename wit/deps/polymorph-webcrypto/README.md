# The `polymorph:webcrypto` package

This document holds the package-wide contracts and the terminology that the
WIT doc comments reference. A doc comment states what is specific to its
item; everything shared lives here.

## How the package is organized

- The `types` interface holds the shared structural types (the `error`
  variant). Structural types carry no host-side identity, so one composition
  can share them across components.
- **Primitive-kind interfaces** (`mac`, `aead`,
  `digest`, `signature`, `derivation`, `key-agreement`, `key-wrap`,
  `public-encryption`) own the
  algorithm-agnostic resources.
  Operations hang off key resources. Adding an algorithm does not change
  these interfaces. The `wrapping` interface holds the provider-held
  intermediates key wrapping trades in (`wrap-input`, `unwrap-input`), as
  `derivation` holds `derive-input`.
- **Algorithm interfaces** (`hmac-sha2`, `aes-gcm`, `aes-kw`,
  `sha2`, `hkdf`, `ed25519-*`, `ecdsa-*`, `x25519`,
  `ecdh`, `rsassa-pkcs1-v15-*`, `rsa-pss-*`, `rsa-oaep-*`) only mint
  keys, bound
  to their algorithm at creation. A key can therefore never be used with
  the wrong algorithm.

A component whose world imports only a primitive-kind interface can *use*
any key handle it is granted, but cannot mint or import keys. Key handles
are [capabilities](#terminology).

Operations are one-shot calls on immutable key resources. There are no
stateful computation objects, so misuse of in-progress state (concurrent
update, use after finalization) cannot be expressed, and the `error`
variant carries no misuse cases.

## Streaming contract

Every stream-taking operation in the package follows these rules.

**Stream-closure rule.** An operation's input stream ends before the
operation completes. Completion is the result resolving — except a success
carrying an output stream, which completes when that stream ends (its `ok`
may resolve while the input is still being consumed; see the `seal` docs).
Either side may end the input: the caller by dropping the writer (end of
input), or the implementation by dropping the reader — the latter only
when the operation fails, with the error resolving only after the drop.
Consequences: an operation that completes without error consumed the
entire input; a concurrent feeder always completes its feed no later than
the operation; and a write returning unwritten bytes is never itself the
verdict — await the result and report its error. A completed operation
alongside unwritten input indicates a defective implementation.

**Truncating producers (security-critical).** Dropping the writer is a
stream's only end-of-input signal, and it carries no verdict. A producer
that fails midway is indistinguishable from one that finished: the
operation correctly computes over the delivered prefix. When the write path
can fail independently of the party that consumes the result (for example,
a writable end forwarded to another component), convey completeness in-band
(for example, length framing), or discard the result on producer failure.

**Making progress.** An implementation holds each in-flight operation's
bytes, so it bounds how many operations it services at once (by leaving a
call waiting to start). A caller with several operations in flight must
make progress on all of them concurrently:

- feed each operation's input stream without waiting on any other
  operation, and
- drain each returned stream as it becomes available.

A caller that withholds one in-flight operation's input or output while it
awaits another can deadlock against that bound, and no implementation can
rescue it: the bytes the implementation waits to reclaim are the bytes the
caller holds. The natural shape is safe: await an operation and drain its
stream in the same task, and run those tasks concurrently. Deferring every
read until the last call has returned is the shape that is not safe.

**Returned streams.** Read a returned stream to completion, or drop it; an
implementation may hold resources until one of the two happens. Dropping is
always sufficient to release the implementation.

## Key-options contract

Every `*-options` resource follows this contract:

- The constructor grants nothing. Every usage, and extractability, is
  opt-in, so a mint names exactly what the key is for.
- At least one usage must be enabled at mint. An untouched options resource
  cannot mint; the mint fails with `error.not-permitted`.
- The options are single-use: the mint takes ownership, so mutation after a
  mint is unrepresentable.
- An options resource cannot cross providers (resource types are
  per-instance). Construct it from the same import the mint comes from.

The usage vocabulary covers the algorithm family's WebCrypto usages even
where this package has no operation yet: usages are write-once enforcement
bits on platform-backed keys, so a grant absent at mint is unrecoverable
for a non-extractable key. Deny-by-default also covers evolution: future
usages arrive ungranted for every existing caller.

## Extractability

`extractable` is an API property, not a physical one. The implementation
necessarily holds the key material; the guarantee is that a component
holding only the key handle cannot obtain the material through this API.

Every key resource with an extractability gate also exposes it as a getter,
so a holder can ask the question without receiving the material. The getter
matters because a key resource need not have been minted by the component
that holds it.

A platform-resident key can be usable but unreadable. Export operations are
therefore fallible even where no extractability gate applies (see
`signature.verifying-key.export-key-raw`).

## Getter conventions

- `algorithm-*` getters project the
  [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/) registry's
  algorithm properties, spelled and denominated as the registry defines
  them: bit counts for lengths, big-endian bytes for the RSA public
  exponent (`RsaKeyAlgorithm.publicExponent`'s `BigInteger`).
- `*-size` getters report operation-contract quantities in bytes.
- `can-*` getters report the usage recorded at mint (or carried by a
  platform keystore key). An operation the key refuses fails with
  `error.not-permitted`.

## Format naming convention

Key-material functions are suffixed with the encoding they carry —
`-raw`, `-jwk`, and future formats alike — whenever a key's format family
has more than one admissible member. No format is privileged by an
unsuffixed name: this mirrors the Web Cryptography API, where the format
is spelled at every call site, and stays coherent for algorithm families
that have no raw form at all. Single-format-by-platform secrets
(`hkdf.import-ikm`, `pbkdf2.import-password` — WebCrypto accepts only raw
material for both) stay unsuffixed: theirs is not a format choice.

## JWK contract

Every `*-jwk` function follows this contract. The minting interfaces'
`import-key-jwk` docs name their algorithm-specific `alg` values.

- A JWK travels as JSON text. The implementation owns the parse. Duplicate
  members resolve last-wins (ECMA-404 engines' `JSON.parse` semantics,
  pinned so implementations cannot diverge on adversarial input).
  Trailing ASCII space characters (0x20) after the JSON text are accepted
  and ignored — the AES-KW wrapped form pads JWKs with them (see
  `aes-kw`), and the round trip must survive every conforming parse. `k`
  is strict unpadded base64url (RFC 7515): padding, non-alphabet bytes,
  and non-zero trailing bits all fail with `error.invalid-key`.
- Import validates the material-bearing fields: `kty`, the key members
  (`k`, or `crv`/`x`/`y`/`d` for the OKP and EC forms), `alg` where the
  importing interface names accepted values (X25519 ignores `alg`
  entirely, WebCrypto's rule for the ECDH family), and `ext` against the
  requested extractability; failures are `error.invalid-key`. `use` and
  `key_ops` are ignored on the import path: this package has no JWK
  usage model, so they are the consumer's policy to check — the caller
  holds the JWK.
- On the *unwrap* path the caller never sees the JWK, so the JWK-reading
  unwrap mints (`unwrap-key-jwk`, `unwrap-signing-key-jwk`,
  `unwrap-secret-key-jwk`) validate the two usage members in the
  caller's stead (the W3C Web Cryptography API's own `unwrapKey`
  checks): a
  `key_ops` member, when present, must include every usage the mint's
  options grant, under the granted operations' platform names (`seal` →
  `"encrypt"`, `open` → `"decrypt"`, `sign`/`verify` → themselves,
  `wrap`/`unwrap` → `"wrapKey"`/`"unwrapKey"`); a `use` member, when
  present, must match the key's family (`"enc"` for encryption,
  wrapping, and agreement keys; `"sig"` for MAC and signature keys).
  Mismatches fail `error.invalid-key`, the platform's `DataError` for
  these checks.
- A *public-key* import has no extractability request — minted public
  keys are unconditionally exportable — so a public JWK carrying
  `"ext": false` is rejected with `error.invalid-key`.
- Export returns exactly the material-bearing members — `kty`, `k`,
  `alg` for the `oct` form; `kty`, `crv`, `x` (and `y`, and `d` on
  private exports) for the OKP and EC forms, which carry no `alg` — and
  nothing else. Metadata this package does not model (`key_ops`, `ext`,
  `use`) is the consumer's to stamp. Member order is not contract.

## Error contract

No error case reports API misuse: the package aims to make misuse
inexpressible instead (see "Design notes"). The cases that need more than
their doc comment:

**`authentication-failed` is one-sided.** Failed verification MUST report
this case and nothing else; security telemetry may rely on it never being
misfiled. In the other direction, an implementation whose backend collapses
verification failure with other failures (WebCrypto's `decrypt` throws one
`OperationError` for both) MAY report this case for failures it cannot
distinguish from it. Rare operational false positives are therefore
possible on `open`; `verify` is exact on every current implementation,
because boolean-returning backends preserve the distinction. Either way the
case means *unauthenticated input*: at the cryptographic layer, a forgery
and accidental corruption are indistinguishable in principle.

**`other(string)`** carries operational conditions (a keystore that cannot
complete the operation now, an implementation's buffering limit). It never
carries semantic conditions a caller must branch on — and callers must
never branch on its string. A condition that turns out to need branching
or asserting does not stay in `other`: it migrates to a named `extension`
pair, which is a behavioral change for the producing implementation but
never a type change.

**`extension(extension-error)` carries named conditions outside the closed
set — all of them, from here on.** The closed set is frozen: it is the set
of conditions the package's contracts named when the `error` variant was
designed — a historical artifact, not a tier of generality — and it never
grows again, because a new closed case is a semver-major change (the
variant sits in return position, where variant growth has no compatible
path). Every named condition since, kind-level and algorithm-level alike,
is an extension pair under `"polymorph:webcrypto"`, identified by the
(`origin`, `name`) pair and defined by the interface whose contract says
when it occurs — `sha1-checked`'s `("polymorph:webcrypto",
"collision-detected")`, `public-encryption`'s kind-level
`("polymorph:webcrypto", "message-too-long")`. One boundary is absolute:
failed verification reports `authentication-failed` and nothing else
(above), so no extension condition may ever carry a verification verdict.
The record's fields have two fixed roles:

- the (`origin`, `name`) **pair** is the condition's only branchable
  identity;
- **`message`** is human-readable prose for logs and diagnostics — never
  contract, never branched on.

Conditions are *nominal*: the pair identifies, the message elaborates for
humans, and no field carries machine-readable data. Errors in this package
are verdicts — a condition that would need machine-readable parameters
indicates data that belongs on the resource surface (getters, results),
and admitting one would be a deliberate, semver-major redesign of the
error contract.

A consumer MUST handle a pair it does not recognize exactly as it handles
`other`: an operational failure. This rule is what makes migration from
`other` safe — a consumer that predates the named pair observes no change
in kind — and it means the closed set never has to grow again. `origin` is
an opaque namespace owned by the defining party (by convention its package
name; this package defines all of its conditions under
`"polymorph:webcrypto"`). Third-party providers mint conditions under their own
`origin`. SDKs expose constants for known pairs, and the conformance
suites pin exact pairs cross-implementation. The pairs this package
defines are recorded in
[`extension-conditions.json`](extension-conditions.json): the
authoritative spelling, which the SDK constants and the implementations'
mapping tables are gated against.

**Verification returns `result<_, error>`, not `bool`.** An ignored boolean
fails open; a dropped `result` does not.

**Error strings never carry material the caller does not already hold.**
The sharp case is an unwrap mint's `invalid-key`: its parse input is
decrypted key material the design keeps unobservable, so the message MUST
NOT include any of it.

## Timing-channel policy

Some algorithms leak key material through execution timing when the
implementation shares a timing domain with an observer. In particular,
ECDSA signing handles a per-signature secret nonce whose timing leakage is
key-recovering. Providers that execute inside an attacker-observable timing
domain should not export such interfaces; a composition that requires one
then fails at composition (`wac plug`) time rather than at run time. This
repository's in-guest provider documents its classification and policy in
`rust/guest-provider/README.md`.

## Portability contract

The ungated surface behaves identically on every implementation: a
component that uses only ungated interfaces, with inputs inside the
documented contracts, sees the same successes, the same failures, and the
same `error` cases everywhere — moving a composition between
implementations is not an observable event. The conformance suites are
this promise's gate.

Three categories, and only these three, qualify the promise:

- **Gated features** are the opt-in for capability that cannot be uniform
  (a platform withholds the algorithm, or a policy such as the
  timing-channel classes forbids an implementation from serving it). The
  gates and their exit conditions are listed under "Stability gates";
  which implementation serves which gated feature is declared in
  `conformance/driver-ct/targets.toml`. A consumer reaches non-uniform surface only
  by naming the gate.
- **Structural absence** fails at composition time: an implementation may
  withhold an entire interface for cause (the timing-channel policy
  above), and a composition that needs it fails at `wac plug` time,
  before anything runs. Early, total failure is the portable behavior.
- **Recorded latitude**: a few contracts deliberately leave an admission
  middle implementation-defined, marked "do not rely on either behavior"
  at the definition site — compressed-point SPKI encodings, the
  private-JWK public-half consistency checks (MAY validate, MUST NOT
  trust), ASN.1 strictness beyond the documented shape, and unwrap
  verification timing. The portable core around each middle — what is
  guaranteed to import and what is guaranteed to be rejected — is stated
  at the same site and pinned by the conformance suites.

A behavioral difference between implementations outside these three
categories is a defect in an implementation, not latitude.

## Stability gates

Most of the package is ungated. `sha1-checked`, the RSA signing
interfaces, and `rsa-oaep-decrypt` are marked
`@unstable`, so tooling hides them unless a consumer enables the feature
(for example `wasm-tools ... --features`, wit-bindgen's `features` option,
componentize-js's `--features`).

A gate records one or both of two kinds of provisionality, and each
gate's reasons and exit conditions are listed here:

- **Shape**: the interface definition may still move to follow a named
  external. Semver-minor changes may reshape gated interfaces in place.
- **Linkage**: the interface is not servable by every implementation, and
  the component model cannot yet express that at the layer where it
  belongs. Today a guest imports such an interface unconditionally and
  implementations decline minting at runtime with `error.unsupported` —
  a stopgap for instantiation-time-optional imports. These gates lift
  when the toolchains this package rides can express an optional import,
  so consumers never stabilize onto the stopgap as if it were the final
  consumption story.
- **Consent**: the interface is servable, but serving it is a
  per-deployment security judgment the package cannot make or verify
  from inside — the gate is the consumer's explicit assertion of their
  threat model. Consent gates do not lift on tooling improvements; they
  lift only if the underlying judgment ever becomes unconditional.

The gates:

- `@unstable(feature = sha1-checked)` on `sha1-checked` — linkage only.
  The interface shape is settled (sha1dc is a decade stable, with
  nothing external pending), but platform WebCrypto carries no sha1dc,
  so platform-backed providers can never serve it. Exits when optional
  imports are expressible.
- `@unstable(feature = rsa-oaep-decrypt)` on `rsa-oaep-decrypt` —
  consent, the same contract as `rsa-sign` below, with the sharpest
  factual basis in the package: decryption is the operation the RSA
  timing-attack lineage targets, and the one WebCrypto RSA private-op
  CVE to date was a browser's OAEP decryption. `rsa-oaep-encrypt` is
  deliberately ungated: encrypt-side timing has neither a long-lived
  secret nor a repetition axis (the per-call OAEP seed randomizes the
  exponentiated operand), the exponent is public, and the mandatory
  use cases (cloud-KMS key import, TPM credential activation) are
  encrypt-only. Its in-guest absence is structural, like
  `ecdsa-sign`'s.
- `@unstable(feature = rsa-sign)` on `rsassa-pkcs1-v15-sign` and
  `rsa-pss-sign` — consent, primarily. RSA private-key operations leak
  key material through timing unless constant-time end to end, the
  attack lineage is 25 years old and current (the Marvin attack), and
  whether a deployment's timing is attacker-observable is a fact only
  the deployer knows — so the gate is the consumer's assertion of that
  judgment, made under exactly the long-lived, high-value keys
  (code-forge app credentials, DKIM domain keys, open-banking client
  keys) the interfaces exist to serve. The in-guest absence is
  *structural* (the provider's world, like `ecdsa-sign`) and carries no
  gate; browser-backed hosts additionally decline by default behind
  their own recorded opt-in. The consent dimension does not exit.

Neither kind of gate speaks to per-call runtime availability: an
implementation may decline any minting path with `error.unsupported`
either way, and a gated interface a consumer enables still needs the
same handling. Stabilization replaces a gate with `@since` once its
listed exits arrive. Interfaces whose absence is already expressed
structurally carry no gate — `ecdsa-sign` is withheld from
timing-observable providers by *their worlds*, enforced at composition
time, which is the designed end state rather than a stopgap.

Within this repository, only test builds enable the features by default
(the conformance and demo guests, the WPT runners, the timing lab, and
the standalone Wasmtime embedding). The library surfaces keep the gated
default: the guest SDK's gated wrappers and imports sit behind its
`sha1-checked` and RSA cargo features, and the Wasmtime host's
plain `add_to_linker` serves no gated interface
(`add_to_linker_with_options` opts in).

## Design notes

Decisions that shape the surface, recorded so the doc comments can stay
short:

- **Misuse should be unrepresentable — a design goal, not a guarantee.**
  Where possible, the interfaces make mistakes impossible to express
  rather than reporting them: operations are one-shot calls on immutable
  key resources (no in-progress state to misuse), keys bind their
  algorithm at mint, options are consumed by the mint, and the `error`
  variant carries no misuse cases. The goal informs every surface change;
  it is not a claim that no misuse of the package is possible (nonce
  reuse under the caller-nonce `aead` kind is the standing example).
  Where an operation combines *two* key capabilities, misuse is checked
  rather than unrepresentable: `key-agreement.secret-key.agree` fails
  `error.invalid-key` on an algorithm-mismatched peer, the W3C Web
  Cryptography API's own derive-time check.

- **No derive from a secret key to its public half.** A provider may hold
  a private key whose public half it cannot recompute (browser WebCrypto
  has no derive operation, and keystore-resident non-extractable keys sign
  but yield nothing else). `generate-key` returns the pair; importers use
  the public-key import. This holds for `signature` (no `signing-key` →
  `verifying-key`) and for `key-agreement` (no `secret-key` →
  `public-key`) alike; an agreement secret imported as an OKP or EC
  private JWK carries its public coordinates in the JWK itself, where
  RFC 8037 and RFC 7518 make them mandatory.
- **Format admission: every key format is one a platform-backed host
  passes to the platform verbatim.** An import format the platform cannot
  ingest directly would force such a host to parse or transform key
  material itself — exactly the code a thin host should not carry — so
  formats without a platform door (bare X25519 secret scalars, for
  example) are not formats here. The admitted set per algorithm lives on
  its minting interface. The rule is a default, not an invariant: a host
  may additionally run *narrowing* pre-checks — shape tests that reject
  before the platform sees the bytes, never admitting or manufacturing
  what the platform would refuse — where a uniform admission contract is
  worth the check (the risk ladder is recorded in AGENTS.md,
  "Portability"). Transforming or synthesizing key material in a host
  remains out.
- **ECDSA binds curve and hash at mint** (unlike WebCrypto's per-operation
  hash). A granted key cannot be used with a weaker digest than its minter
  chose.
- **Private keys import and export only through platform formats.**
  Signing and agreement secret keys import as PKCS#8 or a private JWK and
  export (extractability-gated, fallibly) the same way — never as bare
  seeds or scalars, per the format-admission rule above. No import derives
  the public half (see the no-derive rule above); importers supply it
  separately through the public-key import.
- **Empty KDF secrets are accepted.** RFC 8018 admits an empty PBKDF2
  `P` and RFC 5869 an empty HKDF IKM; the platform serves both, and the
  upstream PBKDF2 vectors exercise the empty password as valid.
  Rejecting either would break platform fidelity without a safety win: a
  zero-length secret is not meaningfully weaker than a one-byte one, so
  no security line falls at empty. An implementation under an explicit
  security policy MAY still reject degenerate material (the same
  allowance as the HMAC import's short-key bound).
- **AES-192 is declared but declined, everywhere.** The `aes-variant`
  case exists because AES closes the set; no implementation serves it,
  by ruling rather than circumstance. Uniform service is impossible —
  Chromium's WebCrypto omits AES-192 deliberately, a settled position
  with no convergence trajectory — so the choice is between a uniform
  decline and a permanent divergence. The divergence earns no exception:
  AES-192 buys nothing 128 or 256 do not (no security increment that
  matters here, near-zero demand), and unlike the gated features (see
  "Portability contract") it would sit on the ungated, stable AES
  surface, where a consumer reaches it with a `length: 192` typo rather
  than by naming a gate. The uniform decline converts
  works-here-fails-there into a predictable `error.unsupported` on every
  minting path, key derivation at 192 bits included. If real demand
  materializes (JOSE `A192*` interop, say), the exit is the gated-feature
  pattern — served behind an `@unstable` feature and declared missing
  where the platform withholds it — never an implementation serving it
  ungated, which the portability contract forbids. (Contrast P-521,
  whose `ecdsa-variant`/`ecdh-variant` docs leave the door open: every
  platform serves those curves, so a future serving can be uniform.)
- **The SHA-1 HMAC constructions are in, for compatibility.** HMAC-SHA-1,
  HKDF-SHA-1, and PBKDF2-SHA-1 carry deployed systems (TOTP, WPA2-PSK,
  Kerberos string-to-key, WinZip AE-2), and SHA-1's collision breaks do
  not reach them — HMAC rests on the compression function's PRF property.
  They enter as per-algorithm interfaces (`hmac-sha1`, `hkdf-sha1`,
  `pbkdf2-sha1`, parallel to the `-sha2` interfaces) rather than growing
  `sha2-variant`, which SHA-1 cannot join by name; the per-hash prepare
  interfaces share `hkdf.ikm` and `pbkdf2.password`, so one imported
  secret parameterizes either hash family. Bare SHA-1
  digests remain `sha1-checked`'s alone, and **no signature interface
  pairs with SHA-1** (`ecdsa-variant` and `rsa-variant` carry no SHA-1
  case, though every platform serves both pairings): collision
  resistance *is* load-bearing for signature verification — an attacker
  holding a collision presents the signed document's crafted twin — and
  the platforms serve the pairing unmitigated (no engine runs sha1dc),
  a compatibility ratchet this package has no reason to inherit. If
  legacy demand ever materializes, the exit is a *checked* variant
  behind the `sha1-checked` gate — verification whose digest runs
  through sha1dc, byte-identical to the platform on every honest
  document and rejecting collision-crafted ones — never the unmitigated
  pairing.
- **The RSA modulus window is 1024–16384 bits.** A security narrowing,
  not a portability one: engines uniformly admit far smaller moduli
  (512-bit imports verified on Chromium, Firefox, and Node alike), but
  768-bit RSA was publicly factored in 2009 and verification under a
  factorable key authenticates nothing, so the window floors admission
  at the deprecated-but-deployed tier SP 800-131A still allows for
  legacy verification — also the smallest size the platform's own test
  suite exercises. The ceiling bounds work on absurd moduli. Stricter
  policy profiles MAY reject more (the HMAC short-key allowance
  pattern).
- **PSS binds its salt length at mint**, where WebCrypto's `saltLength`
  is per-operation: a granted key verifies one PSS parameterization,
  making salt-length confusion unrepresentable — the same mint-binding
  as ECDSA's digest, with the same consumer story (JOSE's `PS*` fixes
  the salt to the digest length, and a caller holding public material
  can mint one key per parameterization it must serve). Signing goes
  further: `rsa-pss-sign` keys emit salt = digest length with no
  parameter at all — the JOSE/FIPS profile, and the only
  parameterization the verified-lineage backends serve — while
  verification stays parameterized because foreign signatures are facts
  a verifier must meet.
- **RSA signing floors at 2048 bits and generates only standard sizes.**
  The signing interfaces' admission window (2048–8192) and the
  verification window (1024–16384) split exactly along NIST SP
  800-131A's line: sub-2048 signature *generation* has been disallowed
  since 2013 and no deployed protocol requires new sub-2048 signatures
  (DKIM, DNSSEC, and the PKI all verify 2048 everywhere), while
  sub-2048 *verification* remains legacy-use for grandfathered keys.
  `generate-key` narrows further to an enum of the four standard sizes
  with the exponent fixed at 65537 — existing keys are facts an import
  must meet; new keys are choices the API need not offer badly.
- **RSA-OAEP's windows have no legacy tier, and its failures are
  deliberately shapeless.** Admission is 2048–8192 bits on both halves:
  signature verification kept a 1024-bit floor because verifying judges
  *past* artifacts, but encryption creates *future* ones — encrypting a
  fresh secret to a weak key is new exposure, not legacy tolerance.
  Every decryption failure is the one detail-free
  `error.authentication-failed` (wrong-length ciphertext, damaged
  padding, mismatched label — indistinguishable, per RFC 8017: a
  distinguishable verdict is a padding-oracle amplifier), and the
  encrypt-side plaintext bound fails with the named extension condition
  `message-too-long`, which callers may branch on to fall back to
  hybrid wrapping. RSAES-PKCS#1 v1.5 encryption is never a member of
  this package: it is the padding mode the timing-attack lineage exists
  about, and the omission WebCrypto itself is credited for.
- **RSA private-key operations are lineage-pinned where this package
  controls the implementation.** Only one implementation family has
  ever passed side-channel verification for RSA private operations
  (the Marvin methodology's negative result on BoringSSL); the pure-Rust
  `rsa` crate carries an open key-recovery advisory (RUSTSEC-2023-0071)
  for exactly these operations. The package's native host therefore
  backs `rsa-sign` with a BoringSSL-derived implementation and uses the
  pure-Rust crate for verification only, where no secret exists.
  Browser-backed hosts decline the signing interfaces by default — a
  browser is the archetypal attacker-observable timing domain, and the
  one WebCrypto RSA private-op CVE to date was a browser's — behind a
  documented module-level opt-in, mirroring the checked-SHA-1 posture
  export.
- **Unauthenticated modes are in, for compatibility.** AES-CBC and
  AES-CTR are WebCrypto-committed formats real systems must read and
  write, so the package carries them — quarantined in the `cipher` kind,
  which exists so their contract (confidentiality only, uniform `decrypt`
  failure) is stated once and cannot bleed into `aead`: the authenticated
  kind is unchanged, remains the default, and nothing ever falls back
  from one kind to the other. The uniform-failure rule is load-bearing —
  a CBC decryption error names no cause, because a distinguishable
  padding verdict is a padding-oracle amplifier. AES-KW is not part of
  this ruling: it is integrity-checked, and lives in the `key-wrap` kind.
- **Key wrapping trades in provider-held intermediates.** Wrapping is
  serialize-then-encrypt and unwrapping is decrypt-then-mint, split at
  two opaque resources (`wrapping.wrap-input`, `wrapping.unwrap-input`)
  so the key material transits neither half's caller: unwrap can mint a
  *non-extractable* key from wrapped transport, which no composition of
  `open` and `import-key-raw` can express. Consequences, all deliberate:
  - Producing a `wrap-input` sits behind the source key's extractability
    gate — the W3C Web Cryptography API's `wrapKey` rule. A profile that
    serves *wrapped export only* (FIPS 140-3 key transport) mints keys
    extractable, serves `to-wrap-input-*`, and declines the plaintext
    exports under the package's policy-rejection allowance; the WIT does
    not need a separate "wrappable" grant for it.
  - The intermediates cannot cross providers (resource types are
    per-instance), so both halves of a wrap or an unwrap run inside one
    provider and only wrapped bytes travel between parties.
  - The `key-wrap` kind's `wrap` accepts only a `wrap-input`, never
    caller bytes: a deterministic wrapping algorithm (AES-KW) has no
    direct bytes path. The restriction is friction, not a guarantee —
    arbitrary bytes can still arrive through an extractable import, as
    on the platform.
  - Verification timing on `unwrap` is implementation latitude: an
    implementation verifies (and decrypts) at `unwrap` or defers both
    to the consuming mint — a platform host's atomic `unwrapKey`, and a
    future keystore-resident wrapping key, can only defer. The
    invariant is the mint's, not the operation's: no mint succeeds on
    input whose verification fails.
  - Unwrapping under the `cipher` kind is served for WebCrypto parity
    and is unauthenticated like everything in that kind: the typed
    mint's parse is not authentication. The two-step sequence reveals
    exactly what the pre-existing `decrypt`-then-import sequence
    reveals — decryption success and a separate parse verdict — and no
    more.
- **FIPS 140-3 stays possible, not implemented.** Interfaces deliberately
  permit policy-based rejection (short HMAC keys, degenerate KDF secrets),
  and wrapped key export is expressible today (`to-wrap-input-*` behind
  the extractability gate, with the plaintext exports declined under the
  policy-rejection allowance), so a FIPS profile is a provider that
  exports only approved interfaces. The approved-mode AES-GCM *seal* is
  the missing piece: SP 800-38D forbids caller-supplied encryption IVs in
  approved mode, and the internal-nonce kind that carried them was cut
  with the package's narrowing to WebCrypto-standard scope — its design
  is preserved in issue #272.

## Terminology

Brief definitions; follow the links for depth.

- **mint** — create a key resource (import, generate, or derive). The word
  marks the only points at which keys come into existence.
- **capability** — an unforgeable handle whose possession is the
  authority to use it.
  [Capability-based security](https://en.wikipedia.org/wiki/Capability-based_security).
- **unrepresentable (by construction)** — the API's shape makes the mistake
  impossible to express, rather than checking for it at run time.
- **extractable** — whether a key's material may be exported through this
  API. See [Extractability](#extractability).
- **MAC** — message authentication code; a keyed tag over data.
  [Wikipedia](https://en.wikipedia.org/wiki/Message_authentication_code).
- **AEAD** — authenticated encryption with associated data.
  [Wikipedia](https://en.wikipedia.org/wiki/Authenticated_encryption).
- **nonce** — a number used once; AEAD's per-message input. Reuse with the
  same key is catastrophic for GCM-family algorithms.
  [Wikipedia](https://en.wikipedia.org/wiki/Cryptographic_nonce).
- **AAD** — associated data: authenticated but not encrypted AEAD input.
- **tag** — the authentication value a MAC or AEAD produces.
- **digest** — the output of a cryptographic hash function.
  [Wikipedia](https://en.wikipedia.org/wiki/Cryptographic_hash_function).
- **KDF** — key derivation function.
  [Wikipedia](https://en.wikipedia.org/wiki/Key_derivation_function).
- **key agreement** — a protocol in which two parties each combine their
  own secret key with the other's public key and arrive at the same shared
  secret (Diffie–Hellman).
  [Wikipedia](https://en.wikipedia.org/wiki/Key-agreement_protocol).
- **contributory check** — the rejection of an agreement whose shared
  secret one party forced regardless of the other's key. For X25519 the
  degenerate case is the all-zero shared secret, produced exactly by
  small-order peer points ([RFC 7748 §7](https://www.rfc-editor.org/rfc/rfc7748#section-7)).
  For ECDH over the NIST prime-order curves, strict point admission at
  import makes the degenerate case unreachable: a valid point times a
  valid scalar cannot be the point at infinity.
- **IKM** — input keying material: the secret a KDF starts from
  ([RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)).
- **JWK** — JSON Web Key ([RFC 7517](https://www.rfc-editor.org/rfc/rfc7517)).
- **constant time** — execution time independent of secret values, closing
  the timing side channel.
  [Timing attack](https://en.wikipedia.org/wiki/Timing_attack).
- **usage** — a per-key grant recorded at mint that permits an operation
  (WebCrypto's
  [`KeyUsage`](https://www.w3.org/TR/WebCryptoAPI/#dfn-KeyUsage)).
- **key material** — the secret (or, for public keys, encoded) bytes a
  key resource stands for; what import consumes and export returns.
  [Key (cryptography)](https://en.wikipedia.org/wiki/Key_(cryptography)).
- **key wrapping** — encrypting one key's material under another key, for
  transport or storage
  ([NIST SP 800-38F](https://csrc.nist.gov/pubs/sp/800/38/f/final);
  WebCrypto's
  [`wrapKey`](https://www.w3.org/TR/WebCryptoAPI/#SubtleCrypto-method-wrapKey)/`unwrapKey`).
  The wrapping key is often called a key-encryption key (KEK).
- **ICV** — integrity check value: the fixed verification block a
  key-wrap algorithm embeds in the wrapped output; AES-KW's is 64 bits
  ([RFC 3394 §2.2.3](https://www.rfc-editor.org/rfc/rfc3394#section-2.2.3)).
