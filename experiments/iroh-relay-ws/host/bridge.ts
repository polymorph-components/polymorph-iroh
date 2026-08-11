// The websocket bridge: turns the guest's synthetic datagrams (see
// iroh-relay's wasi `datagram_pipe.rs`) into real websocket connections
// through the polymorph-websocket sibling's deltic host module — the
// same browser-first code that serves the WIT package's host half,
// running here as a plain library over the standard `WebSocket` global.
//
// Wire protocol (tag byte first):
//   guest -> bridge  0x00 <url> '\n' <proto,proto>   open a websocket
//   bridge -> guest  0x00 <negotiated-subprotocol>   open acknowledged
//   both             0x01 <bytes>                    one ws binary message
//   bridge -> guest  0x02                            closed / failed
//
// Connections are keyed by the guest socket that carries them (one relay
// connection = one synthetic socket = one websocket).

import { Websocket } from "../../../.deps/websocket/js/deltic/websocket.ts";
import type { OutgoingDatagram, UdpSocket } from "./sockets.ts";
import { pushDatagram, registerBridge } from "./sockets.ts";
import { describeErr } from "./errors.ts";

const TAG_CONTROL = 0x00;
const TAG_MESSAGE = 0x01;
const TAG_CLOSED = 0x02;

const enc = new TextEncoder();
const dec = new TextDecoder();

export const bridgeStats = { connections: 0, wsIn: 0, wsOut: 0 };

interface Conn {
  ws: Websocket;
  sendChain: Promise<void>;
}

/** socket -> live websocket */
const conns = new Map<UdpSocket, Conn>();

function frame(tag: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = tag;
  out.set(bytes, 1);
  return out;
}

async function open(socket: UdpSocket, url: string, protocols: string[]): Promise<void> {
  try {
    const ws = await Websocket.connect(url, protocols);
    conns.set(socket, { ws, sendChain: Promise.resolve() });
    bridgeStats.connections++;
    console.log(`[bridge] ws open ${url} proto=${ws.protocol()}`);
    pushDatagram(socket, frame(TAG_CONTROL, enc.encode(ws.protocol())));
    // rx pump: every ws message becomes one datagram.
    for (;;) {
      let message;
      try {
        message = await ws.receive();
      } catch (err) {
        console.log(`[bridge] ws closed: ${describeErr(err)}`);
        pushDatagram(socket, new Uint8Array([TAG_CLOSED]));
        conns.delete(socket);
        return;
      }
      bridgeStats.wsIn++;
      const bytes = message.tag === "binary" ? message.val : enc.encode(message.val);
      pushDatagram(socket, frame(TAG_MESSAGE, bytes));
    }
  } catch (err) {
    console.error(`[bridge] ws connect failed: ${describeErr(err)}`);
    pushDatagram(socket, new Uint8Array([TAG_CLOSED]));
  }
}

registerBridge(1, (socket: UdpSocket, { data }: OutgoingDatagram) => {
  if (data.length === 0) return;
  const tag = data[0];
  const payload = data.subarray(1);
  switch (tag) {
    case TAG_CONTROL: {
      const text = dec.decode(payload);
      const nl = text.indexOf("\n");
      const url = text.slice(0, nl);
      const protocols = text.slice(nl + 1).split(",").filter(Boolean);
      void open(socket, url, protocols);
      break;
    }
    case TAG_MESSAGE: {
      const conn = conns.get(socket);
      if (!conn) {
        console.error("[bridge] message before websocket open; dropping");
        return;
      }
      bridgeStats.wsOut++;
      // `slice` detaches from any shared buffer; chain preserves ordering.
      const bytes = payload.slice();
      conn.sendChain = conn.sendChain
        .then(() => conn.ws.send({ tag: "binary", val: bytes }))
        .catch((err) => {
          console.error(`[bridge] ws send failed: ${describeErr(err)}`);
          pushDatagram(socket, new Uint8Array([TAG_CLOSED]));
        });
      break;
    }
    default:
      console.error(`[bridge] unknown tag ${tag}`);
  }
});
