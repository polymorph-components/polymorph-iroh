// `wasi:sockets/types@0.3.0` — the UDP direct path, typed per the p3 draft
// the endpoint component actually links (the resource shape below is
// transcribed from the artifact's own embedded WIT, which agrees with
// `wit/deps/wasi-sockets`):
//
//   resource udp-socket {
//     create: static func(address-family: ip-address-family) -> result<udp-socket, error-code>;
//     bind: func(local-address: ip-socket-address) -> result<_, error-code>;
//     send: async func(data: list<u8>, remote-address: option<ip-socket-address>) -> result<_, error-code>;
//     receive: async func() -> result<tuple<list<u8>, ip-socket-address>, error-code>;
//     get-local-address: func() -> result<ip-socket-address, error-code>;
//   }
//
// THE EXAM'S PROFILE IS THE BROWSER PROFILE, WHICH HAS NO UDP. The endpoint
// binds with `udp-bind-addr: none`, and the WIT contract for that field is
// explicit — "`none` binds no socket" (wit/iroh.wit). So
// every function here is a FAIL-ON-CALL stub that returns
// `error-code.not-supported`, which is simultaneously:
//
//   * an honest capability answer (a browser host would answer the same), and
//   * an assertion: `udpCallLog()` staying empty across a whole exam run is
//     the executable proof that the relay/WebRTC legs never reach for a
//     socket. Scenario 1 asserts exactly that.
//
// A direct-path leg (real UDP over `Deno.listenDatagram`) is the natural
// extension once deltic's wasi-shims grow p3 `wasi:sockets` providers
// (lann/deltic#4); this file is where that provider would be wired.

import { WitError } from "@deltic/runtime/embedder";

/** `wasi:sockets/types@0.3.0`'s `ip-address-family` enum. */
export type IpAddressFamily = "ipv4" | "ipv6";

/** `ipv4-address` = `tuple<u8, u8, u8, u8>`. */
export type Ipv4Address = [number, number, number, number];

/** `ipv6-address` = `tuple<u16 × 8>`. */
export type Ipv6Address = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface Ipv4SocketAddress {
  port: number;
  address: Ipv4Address;
}

export interface Ipv6SocketAddress {
  port: number;
  flowInfo: number;
  address: Ipv6Address;
  scopeId: number;
}

/** The `ip-socket-address` variant, in `{ tag, val }` form. */
export type IpSocketAddress =
  | { tag: "ipv4"; val: Ipv4SocketAddress }
  | { tag: "ipv6"; val: Ipv6SocketAddress };

/**
 * The `error-code` variant. Only the cases this stub can produce are
 * spelled as literals; the rest are listed so callers can switch
 * exhaustively against the real WIT vocabulary.
 */
export type SocketErrorCode =
  | { tag: "access-denied" }
  | { tag: "not-supported" }
  | { tag: "invalid-argument" }
  | { tag: "out-of-memory" }
  | { tag: "timeout" }
  | { tag: "invalid-state" }
  | { tag: "address-not-bindable" }
  | { tag: "address-in-use" }
  | { tag: "remote-unreachable" }
  | { tag: "connection-refused" }
  | { tag: "connection-broken" }
  | { tag: "connection-reset" }
  | { tag: "connection-aborted" }
  | { tag: "datagram-too-large" }
  | { tag: "other"; val?: string };

const callLog: string[] = [];

/** Every `wasi:sockets` entry point the guest reached for, in order. */
export function udpCallLog(): readonly string[] {
  return callLog;
}

/** Clear the call log (per-scenario bookkeeping). */
export function resetUdpCallLog(): void {
  callLog.length = 0;
}

function refuse(what: string): never {
  callLog.push(what);
  // A host import signals a WIT `err` by throwing a BRANDED `WitError`
  // (contracts/embedder-api.md, "Error model"): an unbranded throw would
  // become a trap naming the import instead of a guest-visible err.
  const payload: SocketErrorCode = { tag: "not-supported" };
  throw new WitError(payload, `wasi:sockets/types@0.3.0: ${what} is not provided by this host`);
}

/**
 * The host-implemented `udp-socket` resource: a plain class with camelCase
 * methods and the WIT `static` as a JS static (contracts/embedder-api.md,
 * "Resources"). No instance is ever constructed — `create` refuses first.
 */
export class UdpSocket {
  static create(_addressFamily: IpAddressFamily): UdpSocket {
    return refuse("udp-socket.create");
  }

  bind(_localAddress: IpSocketAddress): void {
    return refuse("udp-socket.bind");
  }

  send(_data: Uint8Array, _remoteAddress: IpSocketAddress | undefined): Promise<void> {
    return refuse("udp-socket.send");
  }

  receive(): Promise<[Uint8Array, IpSocketAddress]> {
    return refuse("udp-socket.receive");
  }

  getLocalAddress(): IpSocketAddress {
    return refuse("udp-socket.get-local-address");
  }
}

export const SOCKETS_TYPES_INTERFACE = "wasi:sockets/types@0.3.0";

/** The imports-record fragment for `wasi:sockets/types@0.3.0`. */
export function socketsImports(): Record<string, unknown> {
  return { [SOCKETS_TYPES_INTERFACE]: { UdpSocket } };
}
