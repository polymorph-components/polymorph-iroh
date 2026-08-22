// A hand-written TS facade for `polymorph:iroh/endpoint@0.1.0`, transcribed
// from this repository's WIT (wit/iroh.wit) under the polyengine embedder
// conventions (contracts/embedder-api.md in the polyengine repository):
//
//   * resource -> PascalCase class, methods camelCase, statics static
//   * every export is Promise-shaped; `result<T, E>` in RETURN position
//     resolves T or rejects `ComponentException<E>` (so no `{kind}` unwrapping here)
//   * enums -> kebab-case string literal unions; variants -> `{ kind, value }`
//   * `list<u8>` -> Uint8Array; `option<T>` (outermost) -> `T | undefined`
//   * record fields camelCase; option-typed fields are optional properties
//
// This file is types only: bindgen would emit exactly this shape, and the
// embedder facade is fully untyped at runtime, so these are a cast over the
// real instance.

/** `endpoint-id` = `list<u8>` (32 bytes, an Ed25519 public key). */
export type EndpointId = Uint8Array;

export interface CustomAddr {
  id: bigint;
  data: Uint8Array;
}

export type TransportAddr =
  | { kind: "relay"; value: string }
  | { kind: "ip"; value: string }
  | { kind: "webrtc"; value: string }
  | { kind: "custom"; value: CustomAddr };

export interface EndpointAddr {
  endpointId: EndpointId;
  addrs: TransportAddr[];
}

export type ConnectionState = "connecting" | "open" | "closed";

/** The peer's application close, when one was received (`close-info`). */
export interface CloseInfo {
  /** u64 in WIT: QUIC application close codes reach 2^62 - 1. */
  code: bigint;
  reason: string;
}

export type PathKind = "relay" | "ip" | "webrtc";

/** `polymorph:iroh/types@0.1.0`'s `error` variant. */
export type IrohError =
  | { kind: "closed" }
  | { kind: "reset"; value: bigint }
  | { kind: "connect-failed"; value: string }
  | { kind: "timed-out"; value: string }
  | { kind: "not-supported"; value: string }
  | { kind: "in-use"; value: string }
  | { kind: "invalid-argument"; value: string }
  | { kind: "other"; value: string };

/** The `identity` resource: a non-extractable Ed25519 key pair. */
export interface Identity {
  /** Sync in WIT, Promise-shaped as an export. */
  endpointId(): Promise<EndpointId>;
  [Symbol.dispose](): void;
  drop(): void;
}

/** The shape of `instance.exports["polymorph:iroh/identity-generate@0.1.0"]`. */
export interface IdentityGenerateExports {
  generate(): Promise<Identity>;
}

/**
 * The `endpoint-options` resource: constructed around a borrowed
 * `identity`, then populated through the setters (every setting starts
 * disabled or unset). Consumed by `Endpoint.bind`.
 */
export interface EndpointOptionsInstance {
  addAlpn(alpn: Uint8Array): Promise<void>;
  relayUrl(url: string): Promise<void>;
  udpBindAddr(addr: string): Promise<void>;
  webrtc(enabled: boolean): Promise<void>;
  [Symbol.dispose](): void;
  drop(): void;
}

export interface EndpointOptionsClass {
  new (identity: Identity): EndpointOptionsInstance;
}

/**
 * The option shape `bindEndpoint` (harness.ts) builds an
 * `endpoint-options` resource from.
 */
export interface BindConfig {
  alpns: Uint8Array[];
  /** absent = no home relay. */
  relayUrl?: string;
  /** absent = bind no UDP socket (the browser profile). */
  udpBindAddr?: string;
  webrtc: boolean;
}

export interface SendStream {
  write(bytes: Uint8Array): Promise<void>;
  /** Sync in WIT, Promise-shaped as an export (embedder-api "Functions and async"). */
  finish(): Promise<void>;
  /** u64 in WIT: QUIC codes reach 2^62 - 1; pass a bigint. */
  reset(code: bigint): Promise<void>;
  [Symbol.dispose](): void;
  drop(): void;
}

export interface RecvStream {
  /** `result<option<list<u8>>, error>`: resolves `undefined` at the peer's FIN. */
  read(max: number): Promise<Uint8Array | undefined>;
  /** u64 in WIT: QUIC codes reach 2^62 - 1; pass a bigint. */
  stop(code: bigint): Promise<void>;
  [Symbol.dispose](): void;
  drop(): void;
}

export interface Connection {
  peer(): Promise<EndpointId>;
  alpn(): Promise<Uint8Array>;
  state(): Promise<ConnectionState>;
  path(): Promise<PathKind>;
  openBi(): Promise<[SendStream, RecvStream]>;
  openUni(): Promise<SendStream>;
  acceptBi(): Promise<[SendStream, RecvStream]>;
  acceptUni(): Promise<RecvStream>;
  /** `option<u32>`: path-dependent and not latched (see wit/iroh.wit). */
  maxDatagramSize(): Promise<number | undefined>;
  /** `code` is u64 in WIT: QUIC codes reach 2^62 - 1; pass a bigint. */
  close(code: bigint, reason: string): Promise<void>;
  /** `option<close-info>`: `undefined` unless the peer's application close arrived. */
  waitClosed(): Promise<CloseInfo | undefined>;
  [Symbol.dispose](): void;
  drop(): void;
}

export interface Endpoint {
  id(): Promise<EndpointId>;
  directAddr(): Promise<string | undefined>;
  connect(addr: EndpointAddr, alpn: Uint8Array): Promise<Connection>;
  accept(): Promise<Connection>;
  close(): Promise<void>;
  [Symbol.dispose](): void;
  drop(): void;
}

export interface EndpointClass {
  bind(options: EndpointOptionsInstance): Promise<Endpoint>;
}

/** The shape of `instance.exports["polymorph:iroh/endpoint@0.1.0"]`. */
export interface IrohEndpointExports {
  EndpointOptions: EndpointOptionsClass;
  Endpoint: EndpointClass;
}
