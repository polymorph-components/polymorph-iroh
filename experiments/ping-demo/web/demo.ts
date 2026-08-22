// Ping demo page: session bootstrap (QR), square canvas, ping effects
// mirrored between two browsers over an iroh connection that starts on
// a relay and live-migrates onto a WebRTC data channel (issue #26
// overlay). All demo semantics live here; the guest (a wasip2 iroh
// component) ferries opaque JSON frames and reports status.
//
// URL contract: a bare visit hosts a session and shows a QR of
// `#j=<endpoint id>&r=<relay url>`; visiting such a URL joins that
// session. `?relay=<url>` overrides the relay for both roles (local
// testing against a dev relay).

import { pushDatagram, registerBridge, stats } from "../../iroh-relay-ws/host/sockets.ts";
import { artifactsFrom, guestImports, runGuest } from "../../iroh-relay-ws/host/harness.ts";
import "../../iroh-relay-ws/host/bridge.ts";
import { beginUpgrade, overlayStats } from "./overlay.ts";
import { qrcode } from "./vendor/qrcode.mjs";

const statusEl = document.getElementById("status")!;
const qrBox = document.getElementById("qrbox")!;
const qrCanvas = document.getElementById("qr") as HTMLCanvasElement;
const linkEl = document.getElementById("link") as HTMLAnchorElement;
const canvas = document.getElementById("view") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

// --- session parameters -----------------------------------------------------

const params = new URLSearchParams(location.search);
const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
const relayOverride = params.get("relay") ?? undefined;

// Identity persists per tab (sessionStorage): a refresh rejoins the same
// session with the same endpoint id. The host writes the join payload
// into its own fragment, so role detection is "does the fragment name
// me?" — a fresh tab on a host's URL becomes a joiner, the host's own
// tab re-hosts.
let secret = sessionStorage.getItem("ping-demo-secret");
if (!secret) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  sessionStorage.setItem("ping-demo-secret", secret);
}
const storedId = sessionStorage.getItem("ping-demo-id");
const fragmentPeer = hash.get("j");
const joining = Boolean(fragmentPeer) && fragmentPeer !== storedId;

const env: Record<string, string> = {
  ROLE: joining ? "join" : "host",
  SECRET: secret,
  ...(joining && { PEER: fragmentPeer!, PEER_RELAY: hash.get("r") ?? "" }),
  ...(relayOverride && { RELAY: relayOverride }),
};
const rustLog = (globalThis as { RUST_LOG?: string }).RUST_LOG;
if (rustLog) env.RUST_LOG = rustLog;

// Harness state (asserted by the Playwright test).
const demo = ((globalThis as any).__demo = {
  role: env.ROLE,
  state: "loading",
  path: "none",
  rttUs: 0,
  selfId: storedId,
  peerId: null as string | null,
  relay: null as string | null,
  joinUrl: null as string | null,
  pings: 0,
  remotePings: 0,
  lastRemotePing: null as { x: number; y: number } | null,
  transfers: [] as any[],
  overlay: overlayStats,
  shim: stats,
});

const t0 = performance.now();

function setStatus(state: string, text: string): void {
  demo.state = state;
  statusEl.textContent = text;
  console.log(`[demo] t+${Math.round(performance.now() - t0)}ms state=${state}`);
}

// --- guest event channel (synthetic port 3) ---------------------------------

let guestSocket: any = null;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const GUEST_FROM = { kind: "ipv4" as const, value: { port: 3, address: [127, 0, 0, 1] as [number, number, number, number] } };

function sendToGuest(obj: unknown): void {
  if (!guestSocket) return;
  pushDatagram(guestSocket, encoder.encode(JSON.stringify(obj)), GUEST_FROM);
}

let upgrade: ReturnType<typeof beginUpgrade> | null = null;

registerBridge(3, (socket, { data }) => {
  guestSocket = socket;
  // Download chunks (0x02) stream the currently fetched file.
  if (data.length > 0 && data[0] === 0x02) {
    receiving?.parts!.push(data.slice(1));
    return;
  }
  let msg: any;
  try {
    msg = JSON.parse(decoder.decode(data));
  } catch {
    return;
  }
  switch (msg.t) {
    case "ready": {
      demo.selfId = msg.id;
      demo.relay = msg.relay;
      if (demo.role === "host") {
        sessionStorage.setItem("ping-demo-id", msg.id);
        const url = new URL(location.href);
        url.hash = `j=${msg.id}&r=${encodeURIComponent(msg.relay)}`;
        demo.joinUrl = url.href;
        // The host's own URL carries the session: a refresh re-hosts it,
        // and the address bar is shareable as-is.
        history.replaceState(null, "", url.hash);
        showQr(url.href);
        setStatus("waiting", "scan to join");
      } else {
        setStatus("connecting", "joining session…");
      }
      break;
    }
    case "connected": {
      demo.peerId = msg.peer;
      qrBox.style.display = "none";
      setStatus("connected", "connected · relay");
      upgrade?.close();
      upgrade = beginUpgrade({
        remoteIdHex: msg.peer,
        initiator: demo.role === "host",
        sendSignal: (m) => sendToGuest({ t: "sig", m }),
        onStatus: (s) => console.log(`[overlay] ${s}`),
      });
      break;
    }
    case "sig": {
      upgrade?.signal(msg.m);
      break;
    }
    case "ping": {
      demo.remotePings++;
      demo.lastRemotePing = { x: msg.x, y: msg.y };
      ripple(msg.x, msg.y, "#f0f");
      break;
    }
    // --- file transfer events -------------------------------------------
    case "offer": {
      // Peer offers a blob: fetch it (bao-verified) via the guest.
      onOffer(msg);
      break;
    }
    case "received": {
      onPeerReceived(msg.hash);
      break;
    }
    case "added": {
      onAdded(msg);
      break;
    }
    case "progress": {
      onProgress(msg);
      break;
    }
    case "file-start": {
      onFileStart(msg);
      break;
    }
    case "file-done": {
      onFileDone(msg);
      break;
    }
    case "file-error": {
      onFileError(msg);
      break;
    }
    case "path": {
      demo.path = msg.path;
      demo.rttUs = msg.rtt_us;
      console.log(`[guest] path=${msg.path} rtt=${msg.rtt_us}us`);
      if (demo.state === "connected" || demo.state === "live") {
        const rtt = msg.rtt_us ? ` · ${(msg.rtt_us / 1000).toFixed(1)}ms` : "";
        setStatus("live", `connected · ${msg.path}${rtt}`);
      }
      break;
    }
    case "overlay": {
      console.log(`[guest] overlay ${msg.state}`);
      break;
    }
    case "closed": {
      demo.peerId = null;
      demo.path = "none";
      upgrade?.close();
      upgrade = null;
      if (demo.role === "host") {
        // The guest is accepting again; the same QR/URL rejoins.
        if (demo.joinUrl) showQr(demo.joinUrl);
        setStatus("closed", "peer left · scan to rejoin");
      } else {
        // The guest redials every couple of seconds.
        setStatus("closed", "peer left · reconnecting…");
      }
      break;
    }
    case "error": {
      setStatus("error", `error: ${msg.msg}`);
      break;
    }
  }
});

// --- QR ----------------------------------------------------------------------

function showQr(url: string): void {
  const qr = qrcode(0, "L");
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const scale = Math.max(2, Math.floor(220 / n));
  const size = (n + 8) * scale;
  qrCanvas.width = qrCanvas.height = size;
  const qctx = qrCanvas.getContext("2d")!;
  qctx.fillStyle = "#fff";
  qctx.fillRect(0, 0, size, size);
  qctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) qctx.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale);
    }
  }
  linkEl.href = url;
  linkEl.textContent = url.length > 60 ? `${url.slice(0, 57)}…` : url;
  qrBox.style.display = "flex";
}

// --- canvas + ping effects ---------------------------------------------------

const ripples: { x: number; y: number; color: string; t0: number }[] = [];

function resize(): void {
  const side = Math.min(window.innerWidth, window.innerHeight) - 16;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = canvas.style.height = `${side}px`;
  canvas.width = canvas.height = Math.round(side * dpr);
}
window.addEventListener("resize", resize);
resize();

function ripple(x: number, y: number, color: string): void {
  ripples.push({ x, y, color, t0: performance.now() });
}

canvas.addEventListener("pointerdown", (ev) => {
  const rect = canvas.getBoundingClientRect();
  const x = (ev.clientX - rect.left) / rect.width;
  const y = (ev.clientY - rect.top) / rect.height;
  demo.pings++;
  ripple(x, y, "#0ff");
  sendToGuest({ t: "ping", x, y });
});

function frame(now: number): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const side = canvas.width;
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    const age = (now - r.t0) / 1000;
    if (age > 1) {
      ripples.splice(i, 1);
      continue;
    }
    ctx.beginPath();
    ctx.arc(r.x * side, r.y * side, age * side * 0.35 + side * 0.01, 0, 2 * Math.PI);
    ctx.strokeStyle = r.color;
    ctx.globalAlpha = 1 - age;
    ctx.lineWidth = Math.max(2, side * 0.006) * (1 - age);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- file transfer -------------------------------------------------------
//
// Sender: file bytes stream to the guest in 0x01 chunks; the guest adds
// them to its blob store ("added") and this page offers the hash to the
// peer over the ferry. Receiver: on "offer" it asks its guest to fetch
// (stock iroh-blobs, bao-verified, over a blobs-ALPN connection riding
// the session's path); the bytes come back in 0x02 chunks and become a
// download link. Single-flight per direction, demo-sized cap.

const CHUNK = 16 * 1024 - 1;
const MAX_FILE = 64 * 1024 * 1024;
const filesEl = document.getElementById("transfers")!;
const fileInput = document.getElementById("file") as HTMLInputElement;
let sendSeq = 0;
const sends = new Map<number, any>(); // id -> transfer
const fetches = new Map<string, any>(); // hash -> transfer
let receiving: any = null;

function addTransfer(dir: string, name: string, size: number): any {
  const el = document.createElement("div");
  el.className = "transfer";
  filesEl.appendChild(el);
  const t = { dir, name, size, hash: null, state: "starting", el, t0: performance.now() };
  demo.transfers.push(t);
  return t;
}

function renderTransfer(t: any, text: string, link?: string): void {
  const arrow = t.dir === "up" ? "↑" : "↓";
  const mib = (t.size / (1024 * 1024)).toFixed(1);
  if (link) {
    t.el.textContent = "";
    const a = document.createElement("a");
    a.href = link;
    a.download = t.name;
    a.textContent = `${arrow} ${t.name} · ${mib} MiB · save`;
    t.el.appendChild(a);
  } else {
    t.el.textContent = `${arrow} ${t.name} · ${text}`;
  }
}

async function sendFile(file: File): Promise<void> {
  if (!guestSocket || !demo.peerId) return;
  if (file.size === 0 || file.size > MAX_FILE) {
    const t = addTransfer("up", file.name, file.size);
    t.state = "error";
    renderTransfer(t, file.size === 0 ? "empty" : "too big (max 64 MiB)");
    return;
  }
  const id = sendSeq++;
  const t = addTransfer("up", file.name, file.size);
  sends.set(id, t);
  renderTransfer(t, "reading…");
  const bytes = new Uint8Array(await file.arrayBuffer());
  sendToGuest({ t: "send", id, name: file.name, size: file.size });
  for (let off = 0; off < bytes.length; off += CHUNK) {
    const chunk = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
    const frame = new Uint8Array(1 + chunk.length);
    frame[0] = 0x01;
    frame.set(chunk, 1);
    pushDatagram(guestSocket, frame, GUEST_FROM);
    // Yield so the guest can drain and the UI can paint.
    if ((off / CHUNK) % 64 === 63) {
      renderTransfer(t, `hashing ${Math.round((off / bytes.length) * 100)}%`);
      await new Promise((r) => setTimeout(r));
    }
  }
  renderTransfer(t, "hashing…");
}

function onAdded(msg: any): void {
  const t = sends.get(msg.id);
  if (!t) return;
  t.hash = msg.hash;
  t.state = "offered";
  renderTransfer(t, "sent · waiting for peer");
  sendToGuest({ t: "offer", hash: msg.hash, name: t.name, size: t.size });
}

function onPeerReceived(hash: string): void {
  for (const t of sends.values()) {
    if (t.hash === hash) {
      t.state = "done";
      const secs = (performance.now() - t.t0) / 1000;
      renderTransfer(t, `delivered · ${(t.size / (1024 * 1024) / secs).toFixed(1)} MiB/s`);
      console.log(`[file] up ${t.name} delivered in ${secs.toFixed(1)}s`);
    }
  }
}

function onOffer(msg: any): void {
  const t = addTransfer("down", msg.name, msg.size);
  t.hash = msg.hash;
  t.state = "fetching";
  fetches.set(msg.hash, t);
  renderTransfer(t, "fetching…");
  sendToGuest({ t: "fetch", hash: msg.hash, size: msg.size });
}

function onProgress(msg: any): void {
  const t = fetches.get(msg.hash);
  if (t) renderTransfer(t, `fetching ${Math.round((msg.done / msg.total) * 100)}%`);
}

function onFileStart(msg: any): void {
  const t = fetches.get(msg.hash);
  if (!t) return;
  receiving = t;
  t.parts = [];
}

function onFileDone(msg: any): void {
  const t = fetches.get(msg.hash);
  if (!t || receiving !== t) return;
  receiving = null;
  const blob = new Blob(t.parts, { type: "application/octet-stream" });
  t.parts = null;
  t.bytes = blob.size;
  t.state = "done";
  const secs = (performance.now() - t.t0) / 1000;
  renderTransfer(t, "", URL.createObjectURL(blob));
  sendToGuest({ t: "received", hash: msg.hash });
  console.log(
    `[file] down ${t.name} ${blob.size} bytes in ${secs.toFixed(1)}s = ${(blob.size / (1024 * 1024) / secs).toFixed(1)} MiB/s`,
  );
}

function onFileError(msg: any): void {
  console.error(`[file] error: ${msg.msg}`);
  if (receiving) {
    receiving.state = "error";
    renderTransfer(receiving, `failed: ${msg.msg}`);
    receiving = null;
  }
}

document.getElementById("send-file")!.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  for (const file of fileInput.files ?? []) await sendFile(file);
  fileInput.value = "";
});
window.addEventListener("dragover", (ev) => ev.preventDefault());
window.addEventListener("drop", async (ev) => {
  ev.preventDefault();
  for (const file of ev.dataTransfer?.files ?? []) await sendFile(file);
});

// --- lifecycle ---------------------------------------------------------------

// A real departure (navigation, tab close, bfcache entry) sends a
// best-effort bye so the peer learns immediately; task switches only fire
// visibilitychange and keep the session alive. When the guest cannot
// flush the close in time, the peer's QUIC idle timeout (8s) is the
// backstop. An empty datagram is the guest's bye control frame.
window.addEventListener("pagehide", () => {
  if (guestSocket) pushDatagram(guestSocket, new Uint8Array(0), GUEST_FROM);
});
// A bfcache-restored page holds a frozen guest whose session is long
// dead; reboot — the persisted identity and fragment rejoin by themselves.
window.addEventListener("pageshow", (ev) => {
  if (ev.persisted) location.reload();
});

// --- debug panel ---------------------------------------------------------------

const debugBtn = document.getElementById("debug-toggle")!;
const debugEl = document.getElementById("debug")!;
let debugTimer: ReturnType<typeof setInterval> | null = null;

function renderDebug(): void {
  const o = demo.overlay;
  const s = demo.shim;
  debugEl.textContent = [
    `role      ${demo.role}`,
    `state     ${demo.state}`,
    `self      ${demo.selfId ?? "…"}`,
    `peer      ${demo.peerId ?? "—"}`,
    `relay     ${demo.relay ?? "…"}`,
    `path      ${demo.path}${demo.rttUs ? ` (${(demo.rttUs / 1000).toFixed(1)}ms)` : ""}`,
    `channel   in=${o.in} out=${o.out} dropped=${o.droppedWhileConnecting}`,
    `datagrams in=${s.datagramsIn} out=${s.datagramsOut}`,
    `pings     sent=${demo.pings} received=${demo.remotePings}`,
  ].join("\n");
}

debugBtn.addEventListener("click", () => {
  const visible = debugEl.style.display === "block";
  debugEl.style.display = visible ? "none" : "block";
  if (debugTimer) {
    clearInterval(debugTimer);
    debugTimer = null;
  }
  if (!visible) {
    renderDebug();
    debugTimer = setInterval(renderDebug, 1000);
  }
});

// --- boot --------------------------------------------------------------------

setStatus("loading", "loading component…");
try {
  const [componentBytes, envelopeText] = await Promise.all([
    fetch("./ping-demo.component.wasm").then(async (r) => {
      if (!r.ok) throw new Error(`GET ping-demo.component.wasm: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    }),
    fetch("./ping-demo.plan.json").then((r) => {
      if (!r.ok) throw new Error(`GET ping-demo.plan.json: ${r.status}`);
      return r.text();
    }),
  ]);
  const artifacts = artifactsFrom(envelopeText, componentBytes);
  setStatus("starting", "starting endpoint…");
  runGuest(artifacts, guestImports({ args: ["ping-demo-guest"], env })).catch((err) =>
    setStatus("error", `guest failed: ${err}`)
  );
} catch (err) {
  // Feature-probe only: polyengine's jspi types are module-scoped (no global
  // WebAssembly augmentation), so read the property untyped.
  const jspi = typeof (WebAssembly as { Suspending?: unknown }).Suspending === "function";
  setStatus(
    "error",
    jspi
      ? `failed to load: ${err}`
      : "this browser has no WebAssembly JSPI — use Chrome/Edge (desktop or Android)",
  );
}
