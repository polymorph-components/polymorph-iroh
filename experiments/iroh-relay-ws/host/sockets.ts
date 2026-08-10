// The synthetic WASI network for the upstream-iroh spikes, in deltic's
// embedder conventions (deltic contracts/embedder-api.md).
//
// Descendant of the jco spike shim (which descended from the udp-wake
// probe, PR #18): multiple synthetic UDP sockets — one per relay
// connection pipe plus the iroh magicsock — with guest datagrams routed
// to host-side bridges by well-known port (bridge.ts, webrtc-bridge.ts)
// or by full synthetic destination address (the issue #26 overlay).
//
// deltic's own `wasi-shims` package deliberately stops at tier (a)/(b) of
// the embedder contract's p2 strategy: its pollables are always-ready
// stubs and its clock subscriptions never fire, which busy-loops a guest
// that genuinely parks. The iroh guests park constantly (tokio's reactor
// blocks in `wasi:io/poll#poll`), so this module takes the contract's
// tier (c): `poll` and `Pollable.block` are sync-typed WIT functions
// implemented as Promise-returning JS, declared with the `suspending()`
// marker (embedder-api amendment A1) — the marked import parks the
// calling wasm frame on JSPI, and the marker itself selects jspi mode.
//
// Registered under compatibility-track keys (`@0.2`), so one provider
// serves whatever 0.2.x the guest binary names. Interfaces the guest
// links but can never use functionally (tcp, ip-name-lookup) are typed
// stubs that fail with WIT error values, not traps.
//
// Environment-portable: standard globals only (`performance`, `crypto`,
// `console`); works under Deno and in browsers.

import { suspending, WitError } from "@deltic/runtime/embedder";

// ---------------------------------------------------------------------------
// instrumentation

export const stats = {
  pollCalls: 0,
  pollSuspends: 0,
  blocks: 0,
  datagramsIn: 0, // bridge -> guest
  datagramsOut: 0, // guest -> bridge
};

// ---------------------------------------------------------------------------
// value shapes (contracts/embedder-api.md value table)

/** `wasi:sockets/network.ip-socket-address` — variant of camelCase records. */
export interface Ipv4SocketAddress {
  port: number;
  /** `ipv4-address` is a tuple: a real 4-element array. */
  address: [number, number, number, number];
}
export type IpSocketAddress =
  | { tag: "ipv4"; val: Ipv4SocketAddress }
  | { tag: "ipv6"; val: { port: number; flowInfo: number; address: number[]; scopeId: number } };

/** `wasi:sockets/udp.incoming-datagram` (record, camelCase fields). */
export interface IncomingDatagram {
  data: Uint8Array;
  remoteAddress: IpSocketAddress;
}

/** `wasi:sockets/udp.outgoing-datagram` — `remoteAddress` is an option. */
export interface OutgoingDatagram {
  data: Uint8Array;
  remoteAddress?: IpSocketAddress;
}

// ---------------------------------------------------------------------------
// wasi:io/poll — tier (c): pollables that really park

/** Nanosecond monotonic clock over `performance.now()`. */
const hrnow = (): bigint => BigInt(Math.round(performance.now() * 1e6));

export class Pollable {
  #readyFn: () => boolean;
  #waitFn: () => Promise<void>;
  constructor(readyFn: () => boolean, waitFn: () => Promise<void>) {
    this.#readyFn = readyFn;
    this.#waitFn = waitFn;
  }
  ready(): boolean {
    return this.#readyFn();
  }
  /** Sync WIT function that genuinely parks: tier (c), `@suspending`. */
  @suspending
  async block(): Promise<void> {
    stats.blocks++;
    while (!this.#readyFn()) await this.#waitFn();
  }
  waitPromise(): Promise<void> {
    return this.#waitFn();
  }
}

// Every `own<pollable>` handed to the guest is a FRESH instance: two own
// handles sharing one host instance alias one registry rep, and the first
// guest-side drop would kill both (HostResourceRegistry semantics).
const ready = (): Pollable => new Pollable(() => true, () => Promise.resolve());
const never = (): Pollable => new Pollable(() => false, () => new Promise<void>(() => {}));

/** Duck-typed views of foreign pollables (deltic wasi-shims tier-(a) ones). */
interface PollableLike {
  ready(): boolean;
  waitPromise?: () => Promise<void>;
}

/**
 * `wasi:io/poll#poll` — sync WIT, Promise-returning JS (tier (c)).
 *
 * The list mixes this module's pollables with foreign ones (deltic
 * wasi-shims' stdio/filesystem pollables are always-ready stubs without
 * `waitPromise`), so readiness is duck-typed: a foreign pollable that is
 * not ready can never wake us, exactly like the NEVER pollable.
 */
async function poll(list: PollableLike[]): Promise<number[]> {
  stats.pollCalls++;
  for (;;) {
    const ready: number[] = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].ready()) ready.push(i);
    }
    if (ready.length) return ready;
    stats.pollSuspends++;
    await Promise.race(list.map((p) => p.waitPromise?.() ?? new Promise<void>(() => {})));
  }
}

// ---------------------------------------------------------------------------
// wasi:clocks/monotonic-clock — subscriptions that really fire

function timerPollable(deadlineNs: bigint): Pollable {
  return new Pollable(
    () => hrnow() >= deadlineNs,
    () =>
      new Promise((r) => {
        const ms = Number(deadlineNs - hrnow()) / 1e6;
        setTimeout(r, Math.max(0, ms));
      }),
  );
}

const monotonicClock = {
  now: hrnow,
  resolution: (): bigint => 1_000n,
  subscribeInstant: (when: bigint): Pollable => timerPollable(when),
  subscribeDuration: (ns: bigint): Pollable => timerPollable(hrnow() + ns),
};

// ---------------------------------------------------------------------------
// wasi:sockets — the synthetic network (multi-socket)

export class Network {
  [Symbol.dispose](): void {}
}
const theNetwork = new Network();

/** The relay-ws bridge's well-known synthetic address (see the guest's
 * datagram-pipe use of iroh-relay's wasi `connect()`). */
export const BRIDGE_ADDR: IpSocketAddress = {
  tag: "ipv4",
  val: { port: 1, address: [127, 0, 0, 1] },
};

let nextEphemeralPort = 0xc000;

type BridgeFn = (socket: UdpSocket, datagram: OutgoingDatagram) => void;

/** Bridges by well-known destination port (1 = relay ws, 2 = webrtc
 * control, 3 = the ping demo's page ferry). */
const bridges = new Map<number, BridgeFn>();

/** Bridge hook: claim every guest datagram sent to the given port. */
export function registerBridge(port: number, cb: BridgeFn): void {
  bridges.set(port, cb);
}

/**
 * Overlay routes by full destination address ("a.b.c.d:port"), consulted
 * before the port bridges: synthetic peer addresses assigned by a bridge
 * route here, whatever socket the guest sends from.
 */
const addrRoutes = new Map<string, BridgeFn>();

const addrKey = (remoteAddress: IpSocketAddress): string =>
  `${(remoteAddress.val.address as number[]).join(".")}:${remoteAddress.val.port}`;

/** Bridge hook: claim guest datagrams to one synthetic address. */
export function registerAddrRoute(
  address: readonly number[],
  port: number,
  cb: BridgeFn,
): void {
  addrRoutes.set(`${address.join(".")}:${port}`, cb);
}

/** All bound sockets by assigned local port (for bridge-initiated delivery). */
const socketsByPort = new Map<number, UdpSocket>();

/** Bridge hook: find a guest socket by its bound local port. */
export function socketByLocalPort(port: number): UdpSocket | undefined {
  return socketsByPort.get(port);
}

/** Bridge hook: deliver a datagram to a socket, from the given address. */
export function pushDatagram(
  socket: UdpSocket,
  bytes: Uint8Array,
  fromAddr: IpSocketAddress = BRIDGE_ADDR,
): void {
  stats.datagramsIn++;
  socket.queue.push({ data: bytes, remoteAddress: fromAddr });
  socket.arrived();
}

export class IncomingDatagramStream {
  #sock: UdpSocket;
  constructor(sock: UdpSocket) {
    this.#sock = sock;
  }
  receive(maxResults: bigint): IncomingDatagram[] {
    const q = this.#sock.queue;
    return q.splice(0, Math.min(Number(maxResults), q.length));
  }
  subscribe(): Pollable {
    const sock = this.#sock;
    return new Pollable(
      () => sock.queue.length > 0,
      () => sock.arrivalPromise,
    );
  }
  [Symbol.dispose](): void {}
}

/** Unroutable destinations already reported (e.g. net_report QAD probes
 * toward the relay's UDP port — unreachable through the pipe by design). */
const unbridgedLogged = new Set<string>();

export class OutgoingDatagramStream {
  #sock: UdpSocket;
  constructor(sock: UdpSocket) {
    this.#sock = sock;
  }
  checkSend(): bigint {
    return 64n;
  }
  send(datagrams: OutgoingDatagram[]): bigint {
    for (const d of datagrams) {
      stats.datagramsOut++;
      const route = d.remoteAddress?.val ? addrRoutes.get(addrKey(d.remoteAddress)) : undefined;
      if (route) {
        route(this.#sock, d);
        continue;
      }
      const port = d.remoteAddress?.val?.port;
      const bridge = port === undefined ? undefined : bridges.get(port);
      if (bridge) {
        bridge(this.#sock, d);
      } else {
        const key = d.remoteAddress ? addrKey(d.remoteAddress) : String(port);
        if (!unbridgedLogged.has(key)) {
          unbridgedLogged.add(key);
          console.error(`[sockets] datagrams to unbridged ${key}; dropping (reported once)`);
        }
      }
    }
    return BigInt(datagrams.length);
  }
  subscribe(): Pollable {
    return ready();
  }
  [Symbol.dispose](): void {}
}

type AddressFamily = "ipv4" | "ipv6";

export class UdpSocket {
  family: AddressFamily;
  bound = false;
  localAddr: IpSocketAddress | null = null;
  queue: IncomingDatagram[] = [];
  arrivalPromise!: Promise<void>;
  arrived!: () => void;
  /** Set by the overlay bridge: which registered endpoint sends from here. */
  overlayOwner?: string;
  #pendingBind: IpSocketAddress | null = null;

  constructor(family: AddressFamily) {
    this.family = family;
    this.#rearm();
  }
  #rearm(): void {
    let resolve!: () => void;
    this.arrivalPromise = new Promise<void>((r) => (resolve = r));
    this.arrived = () => {
      resolve();
      this.#rearm();
    };
  }

  startBind(_network: Network, localAddress: IpSocketAddress): void {
    this.#pendingBind = localAddress;
  }
  finishBind(): void {
    if (this.#pendingBind === null) throw new WitError("not-in-progress");
    let addr = this.#pendingBind;
    this.#pendingBind = null;
    if (addr.val.port === 0) {
      addr = {
        tag: addr.tag,
        val: { ...addr.val, port: nextEphemeralPort++ },
      } as IpSocketAddress;
    }
    this.localAddr = addr;
    this.bound = true;
    socketsByPort.set(addr.val.port, this);
  }
  stream(
    _remote?: IpSocketAddress,
  ): [IncomingDatagramStream, OutgoingDatagramStream] {
    return [new IncomingDatagramStream(this), new OutgoingDatagramStream(this)];
  }
  localAddress(): IpSocketAddress {
    if (!this.bound || this.localAddr === null) throw new WitError("invalid-state");
    return this.localAddr;
  }
  remoteAddress(): IpSocketAddress {
    throw new WitError("invalid-state");
  }
  addressFamily(): AddressFamily {
    return this.family;
  }
  unicastHopLimit(): number {
    return 64;
  }
  setUnicastHopLimit(_v: number): void {}
  receiveBufferSize(): bigint {
    return 262144n;
  }
  setReceiveBufferSize(_v: bigint): void {}
  sendBufferSize(): bigint {
    return 262144n;
  }
  setSendBufferSize(_v: bigint): void {}
  subscribe(): Pollable {
    return new Pollable(
      () => this.queue.length > 0,
      () => this.arrivalPromise,
    );
  }
  [Symbol.dispose](): void {}
}

// TCP + name lookup: linked by the libc baseline, never functional.
const unsupported = (): never => {
  throw new WitError("not-supported");
};

export class TcpSocket {
  startBind = unsupported;
  finishBind = unsupported;
  startConnect = unsupported;
  finishConnect = unsupported;
  startListen = unsupported;
  finishListen = unsupported;
  accept = unsupported;
  localAddress = unsupported;
  remoteAddress = unsupported;
  isListening(): boolean {
    return false;
  }
  addressFamily(): AddressFamily {
    return "ipv4";
  }
  setListenBacklogSize = unsupported;
  keepAliveEnabled = unsupported;
  setKeepAliveEnabled = unsupported;
  keepAliveIdleTime = unsupported;
  setKeepAliveIdleTime = unsupported;
  keepAliveInterval = unsupported;
  setKeepAliveInterval = unsupported;
  keepAliveCount = unsupported;
  setKeepAliveCount = unsupported;
  hopLimit = unsupported;
  setHopLimit = unsupported;
  receiveBufferSize = unsupported;
  setReceiveBufferSize = unsupported;
  sendBufferSize = unsupported;
  setSendBufferSize = unsupported;
  shutdown = unsupported;
  subscribe(): Pollable {
    return never();
  }
  [Symbol.dispose](): void {}
}

export class ResolveAddressStream {
  resolveNextAddress(): never {
    throw new WitError("permanent-resolver-failure");
  }
  subscribe(): Pollable {
    return ready();
  }
  [Symbol.dispose](): void {}
}

// ---------------------------------------------------------------------------
// the import fragment

/**
 * The synthetic-network provider fragment (track keys), spread AFTER
 * deltic's `wasiShims(...)` so the tier-(c) `wasi:io/poll` and
 * `wasi:clocks/monotonic-clock` implementations replace the stub tiers
 * (same keys, object-spread override).
 */
export function syntheticNetImports(): Record<string, unknown> {
  return {
    "wasi:io/poll@0.2": { Pollable, poll: suspending(poll) },
    "wasi:clocks/monotonic-clock@0.2": monotonicClock,
    "wasi:sockets/network@0.2": { Network },
    "wasi:sockets/instance-network@0.2": {
      instanceNetwork: (): Network => theNetwork,
    },
    "wasi:sockets/udp@0.2": {
      UdpSocket,
      IncomingDatagramStream,
      OutgoingDatagramStream,
    },
    "wasi:sockets/udp-create-socket@0.2": {
      createUdpSocket: (family: AddressFamily): UdpSocket => new UdpSocket(family),
    },
    "wasi:sockets/tcp@0.2": { TcpSocket },
    "wasi:sockets/tcp-create-socket@0.2": { createTcpSocket: unsupported },
    "wasi:sockets/ip-name-lookup@0.2": {
      ResolveAddressStream,
      resolveAddresses: (): never => {
        throw new WitError("permanent-resolver-failure");
      },
    },
  };
}
