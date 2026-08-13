// Unit tests for the `wasi:sockets/types@0.3.0` UDP provider
// (src/sockets.ts): the address codec, the wasmtime-parity state machine,
// and the error mapping — the parts the endpoint exam exercises only over
// IPv4 loopback happy paths, plus the failure shapes it never reaches.
//
//   deno test -A --config host-deltic/deno.json host-deltic/src/
//
// Every guest-visible failure must arrive as a BRANDED ComponentException
// (contracts/embedder-api.md, "Error model"): an assertion here failing
// with a bare Error means the guest would have seen a trap, not an err.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { ComponentException } from "@deltic/runtime/embedder";
import {
  ipHostname,
  type IpSocketAddress,
  MAX_UDP_DATAGRAM_SIZE,
  parseNetAddr,
  resetUdpCallLog,
  type SocketErrorCode,
  udpCallLog,
  UdpSocket,
} from "./sockets.ts";

const v4 = (address: [number, number, number, number], port: number): IpSocketAddress => ({
  kind: "ipv4",
  value: { port, address },
});

const v6 = (
  address: [number, number, number, number, number, number, number, number],
  port: number,
  scopeId = 0,
): IpSocketAddress => ({
  kind: "ipv6",
  value: { port, flowInfo: 0, address, scopeId },
});

/** The payload kind of a thrown, branded socket error. */
function errKind(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert(e instanceof ComponentException, `expected ComponentException, got ${e}`);
    return (e.payload as SocketErrorCode).kind;
  }
  throw new Error("expected a throw");
}

async function errKindAsync(p: Promise<unknown>): Promise<string> {
  const e = await assertRejects(() => p);
  assert(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return ((e as ComponentException<SocketErrorCode>).payload).kind;
}

function dispose(socket: UdpSocket): void {
  socket[Symbol.dispose]();
}

/** A socket bound to an ephemeral IPv4 loopback port. */
function boundV4(): { socket: UdpSocket; addr: IpSocketAddress } {
  const socket = UdpSocket.create("ipv4");
  socket.bind(v4([127, 0, 0, 1], 0));
  return { socket, addr: socket.getLocalAddress() };
}

// --- address codec -----------------------------------------------------------

Deno.test("codec: IPv4 round trip", () => {
  const addr = v4([127, 0, 0, 1], 4242);
  assertEquals(ipHostname(addr), "127.0.0.1");
  assertEquals(parseNetAddr({ transport: "udp", hostname: "127.0.0.1", port: 4242 }), addr);
});

Deno.test("codec: IPv6 hostname spellings", () => {
  const port = 7;
  assertEquals(
    parseNetAddr({ transport: "udp", hostname: "::1", port }),
    v6([0, 0, 0, 0, 0, 0, 0, 1], port),
  );
  assertEquals(
    parseNetAddr({ transport: "udp", hostname: "::", port }),
    v6([0, 0, 0, 0, 0, 0, 0, 0], port),
  );
  assertEquals(
    parseNetAddr({ transport: "udp", hostname: "2001:db8::8a2e:370:7334", port }),
    v6([0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334], port),
  );
  assertEquals(
    parseNetAddr({ transport: "udp", hostname: "0:0:0:0:0:0:0:1", port }),
    v6([0, 0, 0, 0, 0, 0, 0, 1], port),
  );
  // The dual-stack rendering of an IPv4 sender (see the module header).
  assertEquals(
    parseNetAddr({ transport: "udp", hostname: "::ffff:127.0.0.1", port }),
    v6([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001], port),
  );
  // Zones: numeric parses as the scope-id; a name is not representable.
  assertEquals(
    parseNetAddr({ transport: "udp", hostname: "fe80::1%3", port }),
    v6([0xfe80, 0, 0, 0, 0, 0, 0, 1], port, 3),
  );
  assertEquals(
    parseNetAddr({ transport: "udp", hostname: "fe80::1%eth0", port }),
    v6([0xfe80, 0, 0, 0, 0, 0, 0, 1], port, 0),
  );
});

Deno.test("codec: IPv6 hostname formatting is the uncompressed form", () => {
  assertEquals(ipHostname(v6([0, 0, 0, 0, 0, 0, 0, 1], 0)), "0:0:0:0:0:0:0:1");
  assertEquals(
    ipHostname(v6([0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334], 0)),
    "2001:db8:0:0:0:8a2e:370:7334",
  );
});

// --- bind + local address ----------------------------------------------------

Deno.test("bind: ephemeral IPv4 loopback, get-local-address reports the port", () => {
  const { socket, addr } = boundV4();
  try {
    assertEquals(addr.kind, "ipv4");
    if (addr.kind !== "ipv4") return;
    assertEquals(addr.value.address, [127, 0, 0, 1]);
    assert(addr.value.port !== 0, "an ephemeral port was assigned");
  } finally {
    dispose(socket);
  }
});

Deno.test("bind: ephemeral IPv6 loopback", () => {
  const socket = UdpSocket.create("ipv6");
  try {
    socket.bind(v6([0, 0, 0, 0, 0, 0, 0, 1], 0));
    const addr = socket.getLocalAddress();
    assertEquals(addr.kind, "ipv6");
    if (addr.kind !== "ipv6") return;
    assertEquals(addr.value.address, [0, 0, 0, 0, 0, 0, 0, 1]);
    assert(addr.value.port !== 0);
  } finally {
    dispose(socket);
  }
});

// --- the data path -----------------------------------------------------------

Deno.test("send/receive: a datagram crosses loopback with its source address", async () => {
  const a = boundV4();
  const b = boundV4();
  try {
    await a.socket.send(new Uint8Array([1, 2, 3]), b.addr);
    const [payload, from] = await b.socket.receive();
    assertEquals(payload, new Uint8Array([1, 2, 3]));
    assertEquals(from, a.addr);
  } finally {
    dispose(a.socket);
    dispose(b.socket);
  }
});

Deno.test("send/receive: a zero-length datagram to self (the pump's self-wake)", async () => {
  const { socket, addr } = boundV4();
  try {
    const pending = socket.receive();
    await socket.send(new Uint8Array(0), addr);
    const [payload, from] = await pending;
    assertEquals(payload.length, 0);
    assertEquals(from, addr);
  } finally {
    dispose(socket);
  }
});

Deno.test("send/receive: a 4096-byte datagram (the guest's packet ceiling)", async () => {
  const a = boundV4();
  const b = boundV4();
  try {
    const big = new Uint8Array(4096);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    await a.socket.send(big, b.addr);
    const [payload] = await b.socket.receive();
    assertEquals(payload, big);
  } finally {
    dispose(a.socket);
    dispose(b.socket);
  }
});

Deno.test("send: implicit bind on an unbound socket", async () => {
  const listener = boundV4();
  const sender = UdpSocket.create("ipv4");
  try {
    await sender.send(new Uint8Array([9]), listener.addr);
    const local = sender.getLocalAddress();
    assert(local.kind === "ipv4" && local.value.port !== 0, "send bound the socket");
    const [payload] = await listener.socket.receive();
    assertEquals(payload, new Uint8Array([9]));
  } finally {
    dispose(sender);
    dispose(listener.socket);
  }
});

// --- error contract ----------------------------------------------------------

Deno.test("errors: the datagram-too-large ceiling, both detection paths", async () => {
  const { socket, addr } = boundV4();
  try {
    // Above the WIT ceiling: refused before the OS.
    assertEquals(
      await errKindAsync(socket.send(new Uint8Array(MAX_UDP_DATAGRAM_SIZE + 1), addr)),
      "datagram-too-large",
    );
    // Under the ceiling but above the UDP payload maximum: the OS's
    // EMSGSIZE, mapped.
    assertEquals(
      await errKindAsync(socket.send(new Uint8Array(65508), addr)),
      "datagram-too-large",
    );
  } finally {
    dispose(socket);
  }
});

Deno.test("errors: the unbound state machine", async () => {
  const socket = UdpSocket.create("ipv4");
  assertEquals(await errKindAsync(socket.receive()), "invalid-state");
  assertEquals(errKind(() => socket.getLocalAddress()), "invalid-state");
});

Deno.test("errors: bind is once-only and surfaces address-in-use", () => {
  const { socket, addr } = boundV4();
  const other = UdpSocket.create("ipv4");
  try {
    assertEquals(errKind(() => socket.bind(v4([127, 0, 0, 1], 0))), "invalid-state");
    assertEquals(errKind(() => other.bind(addr)), "address-in-use");
  } finally {
    dispose(socket);
    dispose(other);
  }
});

Deno.test("errors: send argument validation", async () => {
  const { socket } = boundV4();
  const v6Socket = UdpSocket.create("ipv6");
  try {
    assertEquals(
      await errKindAsync(socket.send(new Uint8Array([1]), undefined)),
      "invalid-argument",
    );
    // Family mismatch, unspecified address, port zero.
    assertEquals(
      await errKindAsync(socket.send(new Uint8Array([1]), v6([0, 0, 0, 0, 0, 0, 0, 1], 9))),
      "invalid-argument",
    );
    assertEquals(
      await errKindAsync(socket.send(new Uint8Array([1]), v4([0, 0, 0, 0], 9))),
      "invalid-argument",
    );
    assertEquals(
      await errKindAsync(socket.send(new Uint8Array([1]), v4([127, 0, 0, 1], 0))),
      "invalid-argument",
    );
    // An IPv4-mapped IPv6 address never crosses the family boundary
    // (wasmtime-wasi parity).
    assertEquals(
      await errKindAsync(
        v6Socket.send(new Uint8Array([1]), v6([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1], 9)),
      ),
      "invalid-argument",
    );
  } finally {
    dispose(socket);
    dispose(v6Socket);
  }
});

Deno.test("errors: a non-zero scope-id is not-supported (recorded divergence)", () => {
  const socket = UdpSocket.create("ipv6");
  try {
    assertEquals(
      errKind(() => socket.bind(v6([0xfe80, 0, 0, 0, 0, 0, 0, 1], 0, 3))),
      "not-supported",
    );
  } finally {
    dispose(socket);
  }
});

Deno.test("errors: create without Deno.listenDatagram is not-supported", () => {
  // The capability answer a UDP-less deployment gives (the pre-UDP browser
  // profile of this host).
  const ns = Deno as { listenDatagram?: unknown };
  const saved = ns.listenDatagram;
  ns.listenDatagram = undefined;
  try {
    assertEquals(errKind(() => UdpSocket.create("ipv4")), "not-supported");
  } finally {
    ns.listenDatagram = saved;
  }
});

// --- teardown ----------------------------------------------------------------

Deno.test("dispose: idempotent; a disposed socket is unbound again", async () => {
  const { socket } = boundV4();
  dispose(socket);
  dispose(socket);
  assertEquals(await errKindAsync(socket.receive()), "invalid-state");
});

Deno.test("dispose: a pending receive settles as a branded err, never a trap", async () => {
  const { socket } = boundV4();
  const pending = socket.receive();
  // Let the receive park before the close pulls the socket out from under
  // it.
  await new Promise((r) => setTimeout(r, 20));
  dispose(socket);
  assertEquals(await errKindAsync(pending), "invalid-state");
});

// --- call log ----------------------------------------------------------------

Deno.test("call log: records the guest's driving sequence", () => {
  resetUdpCallLog();
  const { socket } = boundV4();
  try {
    assertEquals(udpCallLog(), [
      "udp-socket.create",
      "udp-socket.bind",
      "udp-socket.get-local-address",
    ]);
  } finally {
    dispose(socket);
    resetUdpCallLog();
  }
});
