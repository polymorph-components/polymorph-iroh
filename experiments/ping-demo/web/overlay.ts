// The ping-demo overlay bridge: one local endpoint, one remote peer,
// real signaling. Same synthetic-address design as the iroh-relay-ws
// spike (issue #26), reshaped for two browsers: each endpoint's
// synthetic address derives from its endpoint id, so both pages agree
// on the pair's addresses with no exchange beyond the ids they already
// know. Signaling (SDP + ICE candidates) travels through the page,
// which ferries it over the iroh relay connection — authenticated
// end-to-end by iroh before a single candidate is exchanged.
//
// Control protocol with the guest (synthetic port 2), identical to the
// spike:
//   guest -> bridge  0x00 <32B endpoint id> <2B BE udp port>   register
//   bridge -> guest  0x01 <4B ipv4> <2B BE port>               assigned addr
//   bridge -> guest  0x02                                      channel ready
//
// The channel is unreliable and unordered (label "quic",
// maxRetransmits=0); datagrams to the remote synthetic address are
// claimed by an addr route and travel raw; receipts are pushed into the
// guest's iroh UDP socket sourced from the remote synthetic address.

import {
  type DataChannel,
  DataChannelOptions,
  PeerConnection,
  PeerConnectionConfig,
} from "../../../.deps/webrtc/deltic-impl/src/webrtc.ts";
import type { IpSocketAddress, OutgoingDatagram, UdpSocket } from "../../iroh-relay-ws/host/sockets.ts";
import {
  pushDatagram,
  registerAddrRoute,
  registerBridge,
  socketByLocalPort,
} from "../../iroh-relay-ws/host/sockets.ts";
import { describeErr } from "../../iroh-relay-ws/host/errors.ts";

const CONTROL_FROM: IpSocketAddress = { kind: "ipv4", value: { port: 2, address: [127, 0, 0, 1] } };
const TAG_REGISTER = 0x00;
const TAG_ASSIGNED = 0x01;
const TAG_READY = 0x02;
const ID_LEN = 32;
const SYN_PORT = 4433;
const STUN = [{ urls: ["stun:stun.l.google.com:19302"], username: "", credential: "" }];

export const overlayStats = { in: 0, out: 0, droppedWhileConnecting: 0 };

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!, (b) => parseInt(b, 16));

interface SynAddr {
  address: [number, number, number, number];
  port: number;
}

/** Synthetic address for an endpoint: 100.64/10, 22 bits of the id. */
function synAddr(idHex: string): SynAddr {
  const b = hexToBytes(idHex.slice(0, 6));
  return { address: [100, 64 | (b[0] & 0x3f), b[1], b[2]], port: SYN_PORT };
}

interface Self {
  idHex: string;
  udpPort: number;
  controlSocket: UdpSocket;
}

let self_: Self | null = null;

registerBridge(2, (socket: UdpSocket, { data }: OutgoingDatagram) => {
  if (data.length < 1 + ID_LEN + 2 || data[0] !== TAG_REGISTER) return;
  const idHex = Array.from(
    data.subarray(1, 1 + ID_LEN),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const udpPort = (data[1 + ID_LEN] << 8) | data[2 + ID_LEN];
  self_ = { idHex, udpPort, controlSocket: socket };
  const mine = synAddr(idHex);
  const assigned = new Uint8Array(1 + 4 + 2);
  assigned[0] = TAG_ASSIGNED;
  assigned.set(mine.address, 1);
  assigned[5] = mine.port >> 8;
  assigned[6] = mine.port & 0xff;
  pushDatagram(socket, assigned, CONTROL_FROM);
});

export interface UpgradeOptions {
  remoteIdHex: string;
  initiator: boolean;
  sendSignal: (m: unknown) => void;
  onStatus?: (s: string) => void;
}

export interface Upgrade {
  signal(msg: any): Promise<void>;
  /** Ends this upgrade session: later datagrams and signals are dropped. */
  close(): void;
}

/**
 * Starts the webrtc upgrade toward `remoteIdHex`. `sendSignal(obj)` must
 * deliver the object to the remote page (the demo ferries it over the
 * iroh connection); incoming objects go to the returned `signal(obj)`.
 * The deterministic initiator (the session host) avoids glare.
 */
export function beginUpgrade(
  { remoteIdHex, initiator, sendSignal, onStatus = () => {} }: UpgradeOptions,
): Upgrade {
  const remote = synAddr(remoteIdHex);
  const remoteFrom: IpSocketAddress = { kind: "ipv4", value: remote };

  const config = new PeerConnectionConfig();
  config.setIceServers(STUN);
  const pc = new PeerConnection(config);

  let channel: DataChannel | null = null;
  let sendChain = Promise.resolve();
  const backlog: Uint8Array[] = [];
  let remoteDescribed = false;
  let closed = false;
  const pendingCandidates: unknown[] = [];

  // Datagrams toward the remote synthetic address ride the channel. A new
  // session's beginUpgrade re-registers this route, replacing the old one.
  registerAddrRoute(remote.address, remote.port, (_socket, d) => {
    if (closed) return;
    const bytes = d.data.slice();
    if (channel) {
      overlayStats.out++;
      sendChain = sendChain
        .then(() => channel!.send({ kind: "binary", value: bytes }))
        .catch((err) => console.error(`[overlay] send failed: ${describeErr(err)}`));
    } else if (backlog.length < 64) {
      backlog.push(bytes);
    } else {
      overlayStats.droppedWhileConnecting++;
    }
  });

  function pumpChannel(ch: DataChannel): void {
    void (async () => {
      for (;;) {
        let message;
        try {
          message = await ch.receive();
        } catch {
          onStatus("channel closed");
          return;
        }
        overlayStats.in++;
        const bytes =
          message.kind === "binary" ? message.value : new TextEncoder().encode(message.value);
        const sock = self_ && socketByLocalPort(self_.udpPort);
        if (sock) pushDatagram(sock, bytes, remoteFrom);
      }
    })();
  }

  function trickleLocal(): void {
    void (async () => {
      const reader = pc.localIceCandidates().getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sendSignal({ k: "cand", c: value });
      }
    })().catch(() => {});
  }

  async function firstIncomingChannel(): Promise<DataChannel> {
    const reader = pc.incomingDataChannels().getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();
    if (done) throw new Error("peer connection closed before a channel arrived");
    return value;
  }

  function channelOpen(ch: DataChannel): void {
    channel = ch;
    pumpChannel(ch);
    onStatus("channel open");
    for (const bytes of backlog.splice(0)) {
      overlayStats.out++;
      sendChain = sendChain
        .then(() => channel!.send({ kind: "binary", value: bytes }))
        .catch(() => {});
    }
    // Readiness gates the guest's add_external_addr.
    if (self_) pushDatagram(self_.controlSocket, new Uint8Array([TAG_READY]), CONTROL_FROM);
  }

  if (initiator) {
    void (async () => {
      try {
        const options = new DataChannelOptions();
        options.setLabel("quic");
        options.setOrdered(false);
        options.setMaxRetransmits(0);
        const ch = pc.createDataChannel(options);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({ k: "desc", d: offer });
        trickleLocal();
        await pc.waitConnected();
        channelOpen(ch);
      } catch (err) {
        onStatus(`upgrade failed: ${describeErr(err)}`);
      }
    })();
  }

  return {
    async signal(msg: any) {
      if (closed) return;
      try {
        if (msg.k === "desc" && msg.d.kind === "offer") {
          await pc.setRemoteDescription(msg.d);
          remoteDescribed = true;
          for (const c of pendingCandidates.splice(0)) await pc.addIceCandidate(c as any);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal({ k: "desc", d: answer });
          trickleLocal();
          const ch = await firstIncomingChannel();
          await pc.waitConnected();
          channelOpen(ch);
        } else if (msg.k === "desc") {
          await pc.setRemoteDescription(msg.d);
          remoteDescribed = true;
          for (const c of pendingCandidates.splice(0)) await pc.addIceCandidate(c as any);
        } else if (msg.k === "cand") {
          if (remoteDescribed) await pc.addIceCandidate(msg.c);
          else pendingCandidates.push(msg.c);
        }
      } catch (err) {
        onStatus(`signaling failed: ${describeErr(err)}`);
      }
    },
    close() {
      closed = true;
      channel = null;
      try {
        pc.close();
      } catch {
        // best-effort teardown
      }
    },
  };
}
