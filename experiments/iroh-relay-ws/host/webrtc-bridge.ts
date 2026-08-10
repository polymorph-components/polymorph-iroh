// The WebRTC overlay bridge: assigns each registered endpoint a synthetic
// IP address, and carries datagrams for that address over real data
// channels through the polymorph-webrtc-datachannels sibling's deltic
// host module (node-datachannel's W3C polyfill under Deno, the browser
// global in a browser). The guest runs stock iroh IP transports; the
// synthetic address enters iroh through `Endpoint::add_external_addr`,
// rides the NAT-traversal candidate exchange, and the holepunch probes
// are delivered over the channel — the overlay approach from issue #26.
//
// Control protocol on the well-known bridge port 2 (one control socket
// per endpoint, distinct from the iroh UDP socket):
//
//   guest -> bridge  0x00 <32B endpoint id> <2B BE udp port>   register
//   bridge -> guest  0x01 <4B ipv4> <2B BE port>               assigned addr
//   bridge -> guest  0x02                                      channel ready
//
// Data datagrams never touch port 2: sends to a synthetic address are
// claimed by an addr route (whatever socket they come from) and travel
// raw over the pair's channel; receipts are pushed into the peer's
// registered iroh UDP socket with the sender's synthetic address as the
// source. Channels are unreliable and unordered (label "quic",
// maxRetransmits=0); pairing is eager at registration so the channel is
// open before iroh's first probe, with in-process loopback signaling
// (both peers live behind this bridge — in the real design signaling
// rides the relay). While a channel is still connecting, up to 64
// datagrams are buffered and flushed on open.

import {
  type DataChannel,
  DataChannelOptions,
  PeerConnection,
  PeerConnectionConfig,
} from "../../../.deps/webrtc/deltic-impl/src/webrtc.ts";
import type { IpSocketAddress, OutgoingDatagram, UdpSocket } from "./sockets.ts";
import {
  pushDatagram,
  registerAddrRoute,
  registerBridge,
  socketByLocalPort,
} from "./sockets.ts";
import { describeErr } from "./errors.ts";

const WEBRTC_FROM: IpSocketAddress = {
  tag: "ipv4",
  val: { port: 2, address: [127, 0, 0, 1] },
};
const TAG_REGISTER = 0x00;
const TAG_ASSIGNED = 0x01;
const TAG_READY = 0x02;
const ID_LEN = 32;
// Synthetic peer addresses: 100.64.0.<index>:4433 (CGNAT space; spike-local
// fiction — the real design wants a random-prefix ULA, see issue #26).
const SYN_PORT = 4433;

export const webrtcStats = {
  channelsOpened: 0,
  droppedWhileConnecting: 0,
  in: 0,
  out: 0,
};

interface Peer {
  controlSocket: UdpSocket;
  idBytes: Uint8Array;
  udpPort: number;
  synAddr: [number, number, number, number];
}

interface Link {
  state: "connecting" | "open" | "failed";
  send: ((fromHex: string, bytes: Uint8Array) => void) | null;
  backlog: [string, Uint8Array][];
}

/** id hex -> peer */
const peers = new Map<string, Peer>();
/** sorted "a|b" key -> link */
const links = new Map<string, Link>();
let nextPeerIndex = 1;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

const t0 = Date.now();
const ts = (): string => `t+${Date.now() - t0}ms`;

function synFrom(peer: Peer): IpSocketAddress {
  return { tag: "ipv4", val: { port: SYN_PORT, address: peer.synAddr } };
}

/** Forward one raw datagram from `srcHex` toward `dstHex`, buffering while
 * the channel connects. */
function forward(srcHex: string, dstHex: string, bytes: Uint8Array): void {
  const key = linkKey(srcHex, dstHex);
  let link = links.get(key);
  if (!link) {
    // Both ends register before any probe can target them, so pairing has
    // normally started already; this is a fallback.
    link = { state: "connecting", send: null, backlog: [] };
    links.set(key, link);
    console.log(`[webrtc-bridge] ${ts()} lazy pairing ${key.slice(0, 17)}`);
    void establish(key, link, srcHex, dstHex);
  }
  if (link.state === "open" && link.send) {
    webrtcStats.out++;
    link.send(srcHex, bytes);
  } else if (link.state === "connecting" && link.backlog.length < 64) {
    link.backlog.push([srcHex, bytes]);
  } else {
    webrtcStats.droppedWhileConnecting++;
  }
}

registerBridge(2, (socket: UdpSocket, { data }: OutgoingDatagram) => {
  if (data.length === 0 || data[0] !== TAG_REGISTER) {
    console.error(`[webrtc-bridge] unexpected control frame tag ${data[0]}`);
    return;
  }
  if (data.length < 1 + ID_LEN + 2) {
    console.error("[webrtc-bridge] short register frame");
    return;
  }
  const id = hex(data.subarray(1, 1 + ID_LEN));
  const udpPort = (data[1 + ID_LEN] << 8) | data[2 + ID_LEN];
  const index = nextPeerIndex++;
  const peer: Peer = {
    controlSocket: socket,
    idBytes: data.slice(1, 1 + ID_LEN),
    udpPort,
    synAddr: [100, 64, 0, index],
  };
  peers.set(id, peer);
  console.log(
    `[webrtc-bridge] ${ts()} register ${id.slice(0, 8)} udp=${udpPort} -> 100.64.0.${index}:${SYN_PORT}`,
  );

  // Datagrams to this peer's synthetic address, from any guest socket,
  // go over the sender's channel to it.
  registerAddrRoute(peer.synAddr, SYN_PORT, (senderSocket, d) => {
    let srcHex = senderSocket.overlayOwner;
    if (!srcHex) {
      const port = senderSocket.localAddress().val.port;
      for (const [otherHex, other] of peers) {
        if (other.udpPort === port) {
          srcHex = senderSocket.overlayOwner = otherHex;
          break;
        }
      }
    }
    if (!srcHex) {
      console.error("[webrtc-bridge] datagram from unregistered socket; dropping");
      return;
    }
    forward(srcHex, id, d.data.slice());
  });

  // Tell the guest its assigned address.
  const assigned = new Uint8Array(1 + 4 + 2);
  assigned[0] = TAG_ASSIGNED;
  assigned.set(peer.synAddr, 1);
  assigned[5] = SYN_PORT >> 8;
  assigned[6] = SYN_PORT & 0xff;
  pushDatagram(socket, assigned, WEBRTC_FROM);

  // Eager pairing: open the channel before iroh's first probe needs it.
  for (const other of peers.keys()) {
    if (other === id) continue;
    const key = linkKey(id, other);
    if (!links.has(key)) {
      const link: Link = { state: "connecting", send: null, backlog: [] };
      links.set(key, link);
      console.log(`[webrtc-bridge] ${ts()} eager pairing ${key.slice(0, 17)}`);
      void establish(key, link, id, other);
    }
  }
});

/** Drain a ReadableStream of ICE candidates into the peer connection. */
function trickle(
  from: ReturnType<PeerConnection["localIceCandidates"]>,
  into: PeerConnection,
): void {
  void (async () => {
    const reader = from.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await into.addIceCandidate(value);
    }
  })().catch((err) => console.error(`[webrtc-bridge] trickle failed: ${describeErr(err)}`));
}

/** First channel announced by the remote side. */
async function firstIncomingChannel(pc: PeerConnection): Promise<DataChannel> {
  const reader = pc.incomingDataChannels().getReader();
  const { value, done } = await reader.read();
  reader.releaseLock();
  if (done) throw new Error("peer connection closed before a channel arrived");
  return value;
}

/** Pump channel messages into the owner's iroh UDP socket, sourced from the
 * remote peer's synthetic address. */
function pumpChannel(channel: DataChannel, ownerHex: string, remoteHex: string): void {
  void (async () => {
    for (;;) {
      let message;
      try {
        message = await channel.receive();
      } catch (err) {
        console.log(
          `[webrtc-bridge] channel to ${ownerHex.slice(0, 8)} closed: ${describeErr(err)}`,
        );
        return;
      }
      webrtcStats.in++;
      const bytes = message.tag === "binary" ? message.val : new TextEncoder().encode(message.val);
      const owner = peers.get(ownerHex);
      const remote = peers.get(remoteHex);
      if (!owner || !remote) continue;
      const sock = socketByLocalPort(owner.udpPort);
      if (sock) pushDatagram(sock, bytes, synFrom(remote));
    }
  })();
}

async function establish(key: string, link: Link, a: string, b: string): Promise<void> {
  try {
    // Deterministic initiator avoids glare when both sides send first.
    const [ini, resp] = a < b ? [a, b] : [b, a];
    const pcI = new PeerConnection(new PeerConnectionConfig());
    const pcR = new PeerConnection(new PeerConnectionConfig());

    const options = new DataChannelOptions();
    options.setLabel("quic");
    options.setOrdered(false);
    options.setMaxRetransmits(0);
    const chI = pcI.createDataChannel(options);

    const offer = await pcI.createOffer();
    await pcI.setLocalDescription(offer);
    await pcR.setRemoteDescription(offer);
    const answer = await pcR.createAnswer();
    await pcR.setLocalDescription(answer);
    await pcI.setRemoteDescription(answer);

    // Candidate streams buffer from connection creation, so starting the
    // pumps only now (with both remote descriptions set) loses nothing —
    // and avoids InvalidState from candidates arriving pre-description.
    trickle(pcI.localIceCandidates(), pcR);
    trickle(pcR.localIceCandidates(), pcI);

    const chR = await firstIncomingChannel(pcR);
    await pcI.waitConnected();
    await pcR.waitConnected();

    const chans: Record<string, DataChannel> = { [ini]: chI, [resp]: chR };
    pumpChannel(chI, ini, resp);
    pumpChannel(chR, resp, ini);

    const sendChains: Record<string, Promise<void>> = {
      [ini]: Promise.resolve(),
      [resp]: Promise.resolve(),
    };
    link.send = (fromHex, bytes) => {
      const channel = chans[fromHex];
      sendChains[fromHex] = sendChains[fromHex]
        .then(() => channel.send({ tag: "binary", val: bytes }))
        .catch((err) => console.error(`[webrtc-bridge] send failed: ${describeErr(err)}`));
    };
    link.state = "open";
    webrtcStats.channelsOpened++;
    console.log(
      `[webrtc-bridge] ${ts()} channel open ${a.slice(0, 8)} <-> ${b.slice(0, 8)}; flushing ${link.backlog.length} buffered`,
    );
    for (const [fromHex, bytes] of link.backlog.splice(0)) {
      webrtcStats.out++;
      link.send(fromHex, bytes);
    }
    // Readiness gates the guest's add_external_addr: probes fired before
    // the channel opens would only be buffered, not answered in time.
    for (const end of [a, b]) {
      const peer = peers.get(end);
      if (peer) pushDatagram(peer.controlSocket, new Uint8Array([TAG_READY]), WEBRTC_FROM);
    }
  } catch (err) {
    link.state = "failed";
    console.error(`[webrtc-bridge] pairing failed for ${key.slice(0, 17)}: ${describeErr(err)}`);
  }
}
