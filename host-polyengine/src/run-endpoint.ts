// The iroh endpoint exam on the polyengine host: the endpoint COMPONENT
// runtime-linked under stock Deno, with the sibling repositories' polyengine
// host modules supplying every non-WASI import — no transpile step, no
// generated tree, no engine flag.
//
// This is the endpoint workload the jco leg could never run (issue #10 =
// lann/jco#11: a detached pump task holding in-flight imports deadlocks
// every later export call; lann/jco#13: cross-task wakeups are not
// delivered); the jco host has since retired, and this file's driving
// logic is what its held-ready driver would have used.
//
//   just exam-polyengine
//
// `--unstable-net` is not needed by anything here today (see src/sockets.ts:
// the browser profile binds no UDP socket and the exam asserts zero
// `wasi:sockets` calls); a direct-path UDP leg would add it.
//
// ---------------------------------------------------------------------------
// Why the scenarios that run handshakes retry: a guest-side RefCell borrow
// hazard.
//
// `endpoint/src/endpoint_impl.rs` states as an invariant that "the `RefCell`
// borrows never cross an await". One path does:
//
//   State::drain()                       <- runs under shared.borrow_mut()
//     -> noq/rustls handshake work
//       -> Signer::sign  (core/src/crypto/sign.rs)
//         -> wit_bindgen::block_on(polymorph:webcrypto/signature#signing-key.sign)
//
// `block_on` on an async import is a yield point: the callback-ABI
// activation returns to the host and is resumed later, so ANOTHER task of
// the same instance can run while `drain`'s borrow is live. The endpoint's
// other tasks (`connect`, `accept`, `open-bi`, …) all park in `wait_until`,
// whose first act is `shared.borrow_mut()` — which panics `RefCell already
// borrowed`, aborting the guest with an `unreachable` trap. The hazard is
// latent on every host; polyengine reaches it more often because a resolved
// task that blocks mid-frame releases the instance's exclusivity there (a
// documented wasmtime-tracking divergence, polyengine
// runtime/src/jspi/bridge.ts), so a parked poller can interleave with the
// signing window.
//
// The exam therefore RETRIES the racy scenarios a bounded number of times
// and reports the observed panic count as a first-class datum. Every other
// scenario is deterministic.
// ---------------------------------------------------------------------------

import {
  bindEndpoint,
  deadline,
  describeError,
  type EndpointInstance,
  type EndpointInstanceOptions,
  hex,
  newEndpointInstance as packageEndpointInstance,
  shortId,
  utf8,
} from "./harness.ts";
import {
  endpointComponentBytes,
  type Relay,
  RELAY_PORT,
  startRelay,
} from "./repo.ts";

// The exam always runs THIS TREE's freshly built component (repo.ts reads
// it from target/), never the packaged embed, and forwards the
// EXAM_GUEST_LOGS env knob the harness no longer reads ambiently.
async function newEndpointInstance(
  options: EndpointInstanceOptions,
): Promise<EndpointInstance> {
  return await packageEndpointInstance({
    componentBytes: await endpointComponentBytes(),
    guestLogPassthrough: Deno.env.get("EXAM_GUEST_LOGS") === "1",
    ...options,
  });
}
import { ComponentException } from "@polyengine/runtime/embedder";
import { resetUdpCallLog, udpCallLog } from "./sockets.ts";
import type {
  CloseInfo,
  Connection,
  ConnectionState,
  Endpoint,
  PathKind,
  RecvStream,
  TransportAddr,
} from "./types.ts";
import {
  check,
  installPanicWatchdog,
  readAll,
  scenario,
  settle,
  takeGuestPanics,
  type Verdict,
  verdicts_,
} from "./scenario.ts";

const ALPN = utf8.encode("iroh-demo/0");
const MESSAGE = "hello through the endpoint surface";

// The application close the client hangs up with; the server must read
// exactly this from `wait-closed` (mirrors the endpoint demo's
// constants).
const CLOSE_CODE = 17n;
const CLOSE_REASON = "demo done";

// The datagram ceiling the relay path must discover (issue #47): the
// implementation's 4096-byte packet ceiling minus QUIC overhead lands
// a little above this.
const DATAGRAM_CEILING = 3900;

// How long the idle-survival scenario holds a quiet connection open
// (issue #70). noq's max-idle-timeout defaults to 30s on both sides and
// an idle application elicits no packet, so only the guest's keep-alive
// (endpoint_impl.rs `KEEP_ALIVE_INTERVAL`) carries the connection past
// this hold. Real wall time — the exam has no virtual clock.
const IDLE_HOLD_MS = 35_000;

// How long the relay-outage scenario (issue #88) keeps the relay down.
// Real wall time, and deliberately well inside noq's 30s idle timeout:
// the QUIC connection must SURVIVE the outage, so the hold plus the
// redial backoff's ceiling (endpoint_impl.rs `REDIAL_MAX_DELAY`) plus
// the handshake has to stay under it.
const OUTAGE_HOLD_MS = 8_000;

// The budget for the post-outage echo: one redial's backoff ceiling plus
// the reconnect handshake plus the round trip, generously.
const OUTAGE_RECOVERY_MS = 20_000;

// How long redials are left in flight before the endpoints are closed,
// so teardown happens with a relay dial pending.
const OUTAGE_TEARDOWN_MS = 2_000;

/**
 * Bounded retries around the RefCell borrow hazard (see the header). The
 * budget is per-shape because the shapes lose the race at very different
 * rates: with `accept` parked across the handshake there are two pollers
 * (the acceptor and the dialer) live during the two CertificateVerify
 * signatures; with the accept deferred the window is far smaller. Both
 * budgets put the all-attempts-fail probability under ~1%.
 */
const ECHO_ATTEMPTS = 8;
const PARKED_ACCEPT_ATTEMPTS = 20;

// --- the echo exchange (the run-endpoint.mjs choreography) ------------------

interface EchoOptions {
  /** `endpoint-options.webrtc`, and whether to offer a `webrtc` addr hint. */
  readonly webrtc: boolean;
  /** Park `endpoint.accept()` BEFORE the client dials (the jco#13 shape). */
  readonly parkAccept: boolean;
  /** Extra cross-task assertions run inside the exchange. */
  readonly onExchange?: (ctx: ExchangeContext) => Promise<void>;
}

interface ExchangeContext {
  readonly server: EndpointInstance;
  readonly client: EndpointInstance;
  readonly serverEndpoint: Endpoint;
  readonly clientEndpoint: Endpoint;
  readonly clientConn: Connection;
  readonly notes: string[];
}

interface EchoReport {
  readonly serverId: string;
  readonly clientId: string;
  readonly handshakeMs: number;
  readonly roundtripMs: number;
  readonly received: string;
  readonly echoed: string;
  readonly clientPath: PathKind;
  readonly serverPath: PathKind;
  /** What the server's `wait-closed` surfaced: the client's close. */
  readonly serverCloseInfo: CloseInfo;
  readonly notes: string[];
}

async function echoOnce(relay: Relay, options: EchoOptions): Promise<EchoReport> {
  const notes: string[] = [];
  const server = await newEndpointInstance({ label: "server" });
  const client = await newEndpointInstance({ label: "client" });

  const bindOptions = { alpns: [ALPN], relayUrl: relay.url, webrtc: options.webrtc };
  const sep = await deadline(bindEndpoint(server, bindOptions), 30_000, "server bind");
  const cep = await deadline(bindEndpoint(client, bindOptions), 30_000, "client bind");
  const serverId = await sep.id();
  const clientId = await cep.id();

  // The dial hints. A `webrtc` entry is an UPGRADE HINT, not a dial target:
  // the handshake runs on the relay and the packets move to the data channel
  // once it opens (wit/iroh.wit's transport-addr docs).
  const addrs: TransportAddr[] = [{ kind: "relay", value: relay.url }];
  if (options.webrtc) addrs.push({ kind: "webrtc", value: relay.url });

  // The server's accept. Parked BEFORE the dial it is the jco#13 shape (a
  // cross-task wakeup delivered to a task that parked first); deferred it
  // reads the connection out of the pump's `accept_queue` afterwards. Both
  // are legal drivings of the surface; the parked form is the more fragile
  // one against the RefCell borrow hazard (see the header).
  let acceptPromise: Promise<Connection> | undefined;
  if (options.parkAccept) acceptPromise = sep.accept();

  const t0 = performance.now();
  const clientConn = await deadline(
    cep.connect({ endpointId: serverId, addrs }, ALPN),
    60_000,
    "client connect",
  );
  const handshakeMs = performance.now() - t0;

  const serverSide = (async () => {
    const conn = await deadline(acceptPromise ?? sep.accept(), 60_000, "server accept");
    const [send, recv] = await deadline(conn.acceptBi(), 60_000, "server accept-bi");
    const received = await readAll(recv);
    await send.write(utf8.encode(received.toUpperCase()));
    await send.finish();
    // Teardown discipline: the peer's close must be awaited, or
    // CONNECTION_CLOSE may go unsent.
    const closeInfo = await deadline(conn.waitClosed(), 30_000, "server wait-closed");
    const path = await conn.path();
    return { received, peer: await conn.peer(), path, closeInfo, conn };
  })();

  const [send, recv] = await deadline(clientConn.openBi(), 30_000, "client open-bi");
  const t1 = performance.now();
  await send.write(utf8.encode(MESSAGE));
  await send.finish();
  const echoed = await deadline(readAll(recv), 60_000, "client read echo");
  const roundtripMs = performance.now() - t1;

  if (options.onExchange) {
    await options.onExchange({
      server,
      client,
      serverEndpoint: sep,
      clientEndpoint: cep,
      clientConn,
      notes,
    });
  }

  // Read the wire AFTER `onExchange`: the WebRTC upgrade runs in the
  // background and `connection.path` is explicitly NOT latched (its WIT doc
  // comment), so sampling it before the scenario's own bounded wait would
  // race the move it is trying to observe.
  const clientPath = await clientConn.path();

  await clientConn.close(CLOSE_CODE, CLOSE_REASON);
  const clientCloseInfo = await deadline(clientConn.waitClosed(), 30_000, "client wait-closed");
  const s = await deadline(serverSide, 30_000, "server side");

  if (hex(s.peer) !== hex(clientId)) {
    throw new Error(
      `the server authenticated ${shortId(s.peer)}, not the client's ${shortId(clientId)}`,
    );
  }

  // The close-info contract, both directions: the closing side's own
  // `wait-closed` reports none (a locally initiated close), and the
  // closed-on side reads the exact application close that was sent.
  if (clientCloseInfo !== undefined) {
    throw new Error(
      `the client closed locally, but its wait-closed reported a peer close: ` +
        `(${clientCloseInfo.code}, ${JSON.stringify(clientCloseInfo.reason)})`,
    );
  }
  const serverCloseInfo = s.closeInfo;
  if (
    serverCloseInfo === undefined ||
    serverCloseInfo.code !== CLOSE_CODE ||
    serverCloseInfo.reason !== CLOSE_REASON
  ) {
    throw new Error(
      `the server's wait-closed did not surface the client's close ` +
        `(${CLOSE_CODE}, ${JSON.stringify(CLOSE_REASON)}); got ` +
        (serverCloseInfo
          ? `(${serverCloseInfo.code}, ${JSON.stringify(serverCloseInfo.reason)})`
          : "none"),
    );
  }

  await sep.close();
  await cep.close();

  return {
    serverId: hex(serverId),
    clientId: hex(clientId),
    handshakeMs,
    roundtripMs,
    received: s.received,
    echoed,
    clientPath,
    serverPath: s.path,
    serverCloseInfo,
    notes,
  };
}

/**
 * Run `echoOnce` until it completes or the attempt budget runs out, counting
 * the RefCell-hazard guest panics separately from real failures.
 */
async function echoWithRetries(
  relay: Relay,
  v: Verdict,
  options: EchoOptions,
): Promise<EchoReport> {
  let lastError = "";
  let panics = 0;
  const budget = options.parkAccept ? PARKED_ACCEPT_ATTEMPTS : ECHO_ATTEMPTS;
  for (let attempt = 1; attempt <= budget; attempt++) {
    takeGuestPanics();
    try {
      const report = await echoOnce(relay, options);
      await settle();
      const late = takeGuestPanics();
      if (late.length > 0) {
        // A panic in a teardown-phase pump is not an echo failure, but it is
        // never silently dropped.
        panics += late.length;
        v.notes.push(
          `attempt ${attempt}: echo completed, then ${late.length} late guest panic(s)`,
        );
      }
      if (attempt > 1 || panics > 0) {
        v.notes.push(
          `completed on attempt ${attempt}/${budget}; ` +
            `${panics} guest panic(s) observed (RefCell borrow hazard)`,
        );
      }
      return report;
    } catch (err) {
      lastError = describeError(err);
      const seen = takeGuestPanics();
      panics += seen.length;
      const guestPanic = seen.some((p) => p.includes("Trap")) || lastError.includes("Trap");
      console.log(
        `  attempt ${attempt}/${budget} failed: ${lastError}` +
          (guestPanic ? " [RefCell borrow hazard]" : ""),
      );
      await settle(100);
    }
  }
  v.notes.push(`${panics} guest panic(s) across ${budget} attempts (RefCell borrow hazard)`);
  throw new Error(`no attempt completed; last: ${lastError}`);
}

// --- the exam ---------------------------------------------------------------

interface TerminalReport {
  readonly reset: string;
  readonly resetLatched: string;
  readonly closed: string;
  readonly closeInfo: string;
}

/**
 * One run of the stream terminal-outcome probes (issue #13, finding
 * A2): a peer reset and a connection close must surface on `read` —
 * never as a clean FIN — and the outcome must be latched.
 */
async function terminalProbeOnce(relay: Relay): Promise<TerminalReport> {
  const server = await newEndpointInstance({ label: "term-server" });
  const client = await newEndpointInstance({ label: "term-client" });
  const bindOptions = { alpns: [ALPN], relayUrl: relay.url, webrtc: false };
  const sep = await deadline(bindEndpoint(server, bindOptions), 30_000, "server bind");
  const cep = await deadline(bindEndpoint(client, bindOptions), 30_000, "client bind");
  const serverId = await sep.id();

  const conn = await deadline(
    cep.connect({ endpointId: serverId, addrs: [{ kind: "relay", value: relay.url }] }, ALPN),
    60_000,
    "connect",
  );
  const sconn = await deadline(sep.accept(), 60_000, "accept");

  // A peer reset must surface on read, and stay latched.
  const [csend, crecv] = await deadline(conn.openBi(), 30_000, "open-bi");
  await csend.write(utf8.encode("reset-me"));
  await csend.finish();
  const [ssend, srecv] = await deadline(sconn.acceptBi(), 30_000, "accept-bi");
  await readAll(srecv);
  await ssend.reset(77n);
  const reset = await readOutcome(crecv);
  const resetLatched = await readOutcome(crecv);

  // A connection close under an unfinished stream must surface as
  // error.closed; the close itself stays readable (issue #48).
  const [csend2, crecv2] = await deadline(conn.openBi(), 30_000, "open-bi 2");
  await csend2.write(utf8.encode("close-me"));
  await csend2.finish();
  const [ssend2, srecv2] = await deadline(sconn.acceptBi(), 30_000, "accept-bi 2");
  await readAll(srecv2);
  await ssend2.write(utf8.encode("tail")); // deliberately left unfinished
  await sconn.close(9n, "cut");
  const closed = await readOutcome(crecv2);
  const info = await deadline(conn.waitClosed(), 30_000, "client wait-closed");
  const closeInfo = info === undefined ? "none" : `(${info.code}, ${JSON.stringify(info.reason)})`;

  await sep.close();
  await cep.close();
  return { reset, resetLatched, closed, closeInfo };
}

/** Drain reads to the stream's terminal outcome, rendered compactly. */
async function readOutcome(recv: RecvStream): Promise<string> {
  for (;;) {
    let chunk: Uint8Array | undefined;
    try {
      chunk = await deadline(recv.read(65536), 30_000, "read to terminal");
    } catch (err) {
      if (err instanceof ComponentException) {
        const p = err.payload as { kind?: string; value?: unknown } | undefined;
        return p?.kind === "reset" ? `reset(${p.value})` : p?.kind ?? "unknown";
      }
      throw err;
    }
    if (chunk === undefined) return "fin";
  }
}

// --- the idle-survival probe (issue #70) -------------------------------------

interface IdleReport {
  readonly clientState: ConnectionState;
  readonly serverState: ConnectionState;
  /** What the post-idle echo read back; "" when the hold already failed. */
  readonly echoed: string;
  readonly path: PathKind;
  readonly clientCloseInfo: CloseInfo | undefined;
  readonly serverCloseInfo: CloseInfo | undefined;
}

/**
 * One idle-survival probe: dial, prove liveness, go completely quiet for
 * `IDLE_HOLD_MS` — no export call in flight, so the guests' pumps alone
 * must generate the keep-alives (the issue #70 shape) — then prove the
 * connection still works and close it cleanly. A dead connection comes
 * back as a report whose states/echo fail the scenario's checks; only
 * host-side noise throws.
 */
async function idleProbeOnce(relay: Relay): Promise<IdleReport> {
  const server = await newEndpointInstance({ label: "idle-server" });
  const client = await newEndpointInstance({ label: "idle-client" });
  const bindOptions = { alpns: [ALPN], relayUrl: relay.url, webrtc: false };
  const sep = await deadline(bindEndpoint(server, bindOptions), 30_000, "server bind");
  const cep = await deadline(bindEndpoint(client, bindOptions), 30_000, "client bind");
  const serverId = await sep.id();
  const conn = await deadline(
    cep.connect({ endpointId: serverId, addrs: [{ kind: "relay", value: relay.url }] }, ALPN),
    60_000,
    "connect",
  );
  const sconn = await deadline(sep.accept(), 60_000, "accept");
  await echoRoundtrip(conn, sconn, "pre-idle echo");

  await settle(IDLE_HOLD_MS);

  const clientState = await conn.state();
  const serverState = await sconn.state();
  const alive = clientState === "open" && serverState === "open";
  const echoed = alive ? await echoRoundtrip(conn, sconn, "post-idle echo") : "";
  const path = await conn.path();

  await conn.close(CLOSE_CODE, CLOSE_REASON);
  const clientCloseInfo = await deadline(conn.waitClosed(), 30_000, "client wait-closed");
  const serverCloseInfo = await deadline(sconn.waitClosed(), 30_000, "server wait-closed");
  await sep.close();
  await cep.close();
  return { clientState, serverState, echoed, path, clientCloseInfo, serverCloseInfo };
}

/** One echo round-trip on fresh streams: the client writes `MESSAGE`, the
 * server echoes it uppercased; returns what the client read back. */
async function echoRoundtrip(conn: Connection, sconn: Connection, what: string): Promise<string> {
  const [csend, crecv] = await deadline(conn.openBi(), 30_000, `${what}: open-bi`);
  await csend.write(utf8.encode(MESSAGE));
  await csend.finish();
  const [ssend, srecv] = await deadline(sconn.acceptBi(), 30_000, `${what}: accept-bi`);
  const got = await deadline(readAll(srecv), 30_000, `${what}: server read`);
  await ssend.write(utf8.encode(got.toUpperCase()));
  await ssend.finish();
  return await deadline(readAll(crecv), 30_000, `${what}: client read echo`);
}

// --- the relay-outage probe (issue #88) --------------------------------------

/**
 * The relay lifetime the outage probe drives. `stop`/`start` are the
 * harness's own relay process; `url` is stable across a restart (the
 * relay always returns on `RELAY_PORT`).
 */
interface RelayControl {
  url(): string;
  stop(): Promise<void>;
  start(): Promise<void>;
}

interface OutageReport {
  readonly prePath: PathKind;
  readonly preEcho: string;
  /** Whether the port really stopped accepting while the relay was down. */
  readonly wentDown: boolean;
  readonly clientState: ConnectionState;
  readonly serverState: ConnectionState;
  readonly postEcho: string;
  readonly recoveryMs: number;
  /** The echo on a connection dialed AFTER the outage. */
  readonly freshEcho: string;
  /** Guest traps raised while the endpoints closed with redials pending. */
  readonly teardownPanics: string[];
  /** Guest traps raised before teardown (the RefCell borrow hazard). */
  readonly priorPanics: number;
}

/**
 * One relay-outage probe: establish a relay-carried connection, take the
 * relay away for `OUTAGE_HOLD_MS`, bring it back, and require that the
 * connection resumed, that the endpoint still dials, and that closing it
 * with redials in flight raises no trap. A bricked endpoint comes back
 * as a report whose fields fail the scenario's checks; only host-side
 * noise throws.
 */
async function outageProbeOnce(control: RelayControl): Promise<OutageReport> {
  const server = await newEndpointInstance({ label: "outage-server" });
  const client = await newEndpointInstance({ label: "outage-client" });
  const bindOptions = { alpns: [ALPN], relayUrl: control.url(), webrtc: false };
  const sep = await deadline(bindEndpoint(server, bindOptions), 30_000, "server bind");
  const cep = await deadline(bindEndpoint(client, bindOptions), 30_000, "client bind");
  try {
    return await outageProbeBody(control, sep, cep);
  } catch (err) {
    // An attempt that throws still owns two bound endpoints, and their
    // pumps would go on redialing through every later scenario.
    await closeQuietly(cep, "client close after a failed outage attempt");
    await closeQuietly(sep, "server close after a failed outage attempt");
    throw err;
  }
}

/** Close an endpoint without letting its own failure mask another. */
async function closeQuietly(ep: Endpoint, what: string): Promise<void> {
  try {
    await deadline(ep.close(), 15_000, what);
  } catch { /* the endpoint may already be dead; the caller is unwinding */ }
}

async function outageProbeBody(
  control: RelayControl,
  sep: Endpoint,
  cep: Endpoint,
): Promise<OutageReport> {
  const serverId = await sep.id();
  const addrs: TransportAddr[] = [{ kind: "relay", value: control.url() }];
  const conn = await deadline(
    cep.connect({ endpointId: serverId, addrs }, ALPN),
    60_000,
    "connect",
  );
  const sconn = await deadline(sep.accept(), 60_000, "accept");
  const preEcho = await echoRoundtrip(conn, sconn, "pre-outage echo");
  const prePath = await conn.path();

  await control.stop();
  let wentDown = false;
  for (let i = 0; i < 100; i++) {
    if (!await portListening(RELAY_PORT)) {
      wentDown = true;
      break;
    }
    await settle(100);
  }

  // The outage proper: no export call in flight, so the guests' pumps
  // alone drive the redials, and no keep-alive can reach either peer.
  await settle(OUTAGE_HOLD_MS);
  await control.start();

  const clientState = await conn.state();
  const serverState = await sconn.state();
  const alive = clientState === "open" && serverState === "open";
  const startedRecovery = performance.now();
  // The echo does not wait for the reconnection: it is written into a
  // connection whose transmits are being dropped, and QUIC's loss
  // recovery delivers it once the redial lands.
  const postEcho = alive
    ? await deadline(
      echoRoundtrip(conn, sconn, "post-outage echo"),
      OUTAGE_RECOVERY_MS,
      "post-outage echo",
    )
    : "";
  const recoveryMs = performance.now() - startedRecovery;

  // The anti-brick regression: a fresh dial on the SAME endpoints.
  let freshEcho = "";
  if (alive) {
    const fresh = await deadline(
      cep.connect({ endpointId: serverId, addrs }, ALPN),
      60_000,
      "post-outage connect",
    );
    const freshServer = await deadline(sep.accept(), 60_000, "post-outage accept");
    freshEcho = await echoRoundtrip(fresh, freshServer, "post-outage fresh echo");
    await fresh.close(CLOSE_CODE, CLOSE_REASON);
    await conn.close(CLOSE_CODE, CLOSE_REASON);
  }

  // Teardown with redials pending: take the relay away again, let the
  // backoff arm a dial, and close both endpoints on top of it.
  await control.stop();
  await settle(OUTAGE_TEARDOWN_MS);
  const priorPanics = takeGuestPanics().length;
  await deadline(cep.close(), 15_000, "client close mid-redial");
  await deadline(sep.close(), 15_000, "server close mid-redial");
  await settle(500);
  const teardownPanics = takeGuestPanics();
  await control.start();

  return {
    prePath,
    preEcho,
    wentDown,
    clientState,
    serverState,
    postEcho,
    recoveryMs,
    freshEcho,
    teardownPanics,
    priorPanics,
  };
}

async function main(): Promise<number> {
  installPanicWatchdog();
  console.log("iroh endpoint exam (polyengine / stock Deno)");

  let relay = await startRelay();
  // The outage scenario replaces the relay process; every later use
  // reads this binding, and the URL is the same across a restart.
  const relayControl: RelayControl = {
    url: () => relay.url,
    stop: () => relay.stop(),
    start: async () => {
      relay = await startRelay();
    },
  };
  try {
    // -- 1 -------------------------------------------------------------------
    await scenario(1, "bind + identity (webcrypto ed25519 path)", async (v) => {
      resetUdpCallLog();
      const inst = await newEndpointInstance({ label: "solo" });
      const t0 = performance.now();
      const ep = await deadline(
        bindEndpoint(inst, { alpns: [ALPN], relayUrl: relay.url, webrtc: false }),
        30_000,
        "bind",
      );
      const bindMs = performance.now() - t0;
      console.log(`  bind resolved in ${bindMs.toFixed(0)} ms`);

      // `bind` spawned the detached pump and it is ALIVE with in-flight
      // imports (the relay websocket receive) from here on. Every call below
      // is a later export call against a live pump: the exact lann/jco#11
      // shape (issue #10). Under jco the first of them deadlocks.
      const id = await deadline(ep.id(), 10_000, "id() after bind");
      check(v, id.length === 32, `endpoint id is 32 bytes (Ed25519 public key): ${shortId(id)}`);
      const direct = await deadline(ep.directAddr(), 10_000, "direct-addr() after bind");
      check(
        v,
        direct === undefined,
        "direct-addr is none (the browser profile binds no UDP socket)",
      );
      const idAgain = await deadline(ep.id(), 10_000, "id() again");
      check(v, hex(idAgain) === hex(id), "the identity is stable across export calls");
      check(
        v,
        udpCallLog().length === 0,
        `zero wasi:sockets calls (browser profile) — log: [${udpCallLog().join(", ")}]`,
      );
      await deadline(ep.close(), 10_000, "close() after bind");

      // The deployment-profile latitude (wit/iroh.wit, udp-bind-addr):
      // this host has no UDP, so a bind that asks for the direct path
      // must fail not-supported — the stub's honest error-code carried
      // through. Probed after the zero-calls check above: this call is
      // MEANT to reach the stub.
      let unsupported = "no error";
      try {
        await deadline(
          bindEndpoint(inst, {
            alpns: [ALPN],
            relayUrl: relay.url,
            udpBindAddr: "127.0.0.1:0",
            webrtc: false,
          }),
          30_000,
          "bind with udp-bind-addr",
        );
        unsupported = "bind succeeded";
      } catch (err) {
        if (err instanceof ComponentException) {
          const p = err.payload as { kind?: string } | undefined;
          unsupported = p?.kind ?? "unknown";
        } else {
          unsupported = describeError(err);
        }
      }
      check(
        v,
        unsupported === "not-supported",
        `udp-bind-addr on the browser profile fails not-supported: ${unsupported}`,
      );

      await settle();
      check(v, takeGuestPanics().length === 0, "no guest trap during bind/identity");
      v.detail = `bind ${bindMs.toFixed(0)} ms, id ${shortId(id)}, 3 post-pump export calls`;
    });

    // -- 2 -------------------------------------------------------------------
    await scenario(2, "relay echo between two endpoint instances", async (v) => {
      resetUdpCallLog();
      let ceiling = 0;
      let ceilingMs = -1;
      const r = await echoWithRetries(relay, v, {
        webrtc: false,
        parkAccept: false,
        onExchange: async (ctx) => {
          // max-datagram-size is path-dependent and not latched
          // (wit/iroh.wit): the relay wire has no real packet-size
          // limit, so per-path discovery must raise the ceiling well
          // past the 1200-byte floor. Poll for the rise, bounded.
          const started = performance.now();
          for (let i = 0; i < 100; i++) {
            const size = await ctx.clientConn.maxDatagramSize();
            if (size !== undefined && size >= DATAGRAM_CEILING) {
              ceiling = size;
              ceilingMs = performance.now() - started;
              return;
            }
            await settle(100);
          }
          ctx.notes.push(
            `max-datagram-size never reached ${DATAGRAM_CEILING} within 10 s ` +
              `(last: ${await ctx.clientConn.maxDatagramSize()})`,
          );
        },
      });
      check(v, r.received === MESSAGE, `the server received ${JSON.stringify(r.received)}`);
      check(v, r.echoed === MESSAGE.toUpperCase(), `the client read back the echo`);
      check(v, r.clientPath === "relay", `connection.path is "relay" on the client`);
      check(v, r.serverPath === "relay", `connection.path is "relay" on the server`);
      check(
        v,
        r.serverCloseInfo.code === CLOSE_CODE && r.serverCloseInfo.reason === CLOSE_REASON,
        `the server read the client's application close (${CLOSE_CODE}, ` +
          `${JSON.stringify(CLOSE_REASON)}) from wait-closed`,
      );
      check(
        v,
        ceiling >= DATAGRAM_CEILING,
        `max-datagram-size rose to ${ceiling} (>= ${DATAGRAM_CEILING}) on the relay path` +
          (ceilingMs >= 0 ? ` after ${ceilingMs.toFixed(0)} ms` : ""),
      );
      check(v, udpCallLog().length === 0, "zero wasi:sockets calls (relay wire only)");
      v.detail = `handshake ${r.handshakeMs.toFixed(0)} ms, roundtrip ${
        r.roundtripMs.toFixed(0)
      } ms, ${shortId(hexBytes(r.clientId))} -> ${shortId(hexBytes(r.serverId))}`;
    });

    // -- 3 -------------------------------------------------------------------
    await scenario(3, "WebRTC upgrade of a relay-dialed connection", async (v) => {
      resetUdpCallLog();
      let upgradeMs = -1;
      const r = await echoWithRetries(relay, v, {
        webrtc: true,
        parkAccept: false,
        onExchange: async (ctx) => {
          // "A failed upgrade leaves the connection on the relay"
          // (wit/iroh.wit): poll `connection.path` for the move rather
          // than assuming it, bounded.
          const started = performance.now();
          for (let i = 0; i < 100; i++) {
            if (await ctx.clientConn.path() === "webrtc") {
              upgradeMs = performance.now() - started;
              return;
            }
            await settle(100);
          }
          ctx.notes.push("the connection never left the relay within 10 s");
        },
      });
      check(v, r.received === MESSAGE, "the echo crossed while the upgrade ran");
      if (r.clientPath === "webrtc") {
        check(v, true, `connection.path moved to "webrtc" after ${upgradeMs.toFixed(0)} ms`);
        v.detail = `upgraded to the data channel in ${upgradeMs.toFixed(0)} ms`;
      } else {
        // Best-effort by contract, and honestly reported either way.
        v.status = "BLOCKED";
        v.detail =
          `the echo succeeded but connection.path stayed "${r.clientPath}" (no upgrade observed)`;
      }
      for (const n of r.notes) v.notes.push(n);
    });

    // -- 4 -------------------------------------------------------------------
    await scenario(4, "concurrency proof points (issue #10 rows)", async (v) => {
      // 4a — lann/jco#11: an export call AFTER a live detached pump exists.
      // Asserted at scale here: many export calls, on two instances, all with
      // pumps alive and holding in-flight relay imports.
      const a = await newEndpointInstance({ label: "proof-a" });
      const b = await newEndpointInstance({ label: "proof-b" });
      const epA = await deadline(
        bindEndpoint(a, { alpns: [ALPN], relayUrl: relay.url, webrtc: false }),
        30_000,
        "proof-a bind",
      );
      const epB = await deadline(
        bindEndpoint(b, { alpns: [ALPN], relayUrl: relay.url, webrtc: false }),
        30_000,
        "proof-b bind",
      );
      let calls = 0;
      for (let i = 0; i < 10; i++) {
        await epA.id();
        await epB.id();
        await epA.directAddr();
        await epB.directAddr();
        calls += 4;
      }
      check(v, calls === 40, `${calls} export calls completed with two live pump tasks (jco#11)`);
      await epA.close();
      await epB.close();

      // 4b — lann/jco#13: cross-task wakeups through waitables. The server
      // parks `accept-bi` and `wait-closed` BEFORE the client's work exists;
      // both are resolved by the pump on the client's activity, i.e. by a
      // wakeup crossing from one task to another.
      let parkedFirst = false;
      let acceptBiResolvedAfterWrite = false;
      const r = await echoWithRetries(relay, v, {
        webrtc: false,
        parkAccept: true,
        onExchange: (ctx) => {
          parkedFirst = true;
          ctx.notes.push("endpoint.accept was parked before the client dialed");
          return Promise.resolve();
        },
      });
      acceptBiResolvedAfterWrite = r.received === MESSAGE;
      check(v, parkedFirst, "endpoint.accept parked before the dial and was woken by the pump");
      check(
        v,
        acceptBiResolvedAfterWrite,
        "connection.accept-bi + wait-closed woke on peer activity (jco#13)",
      );

      // NOT CLAIMED: lann/jco#14's composed async call. The endpoint is a
      // SINGLE component here (no `wac plug`); the composed demo
      // (endpoint-demo) carries that shape.
      v.notes.push("jco#14 (composed async calls) is NOT exercised: single component, no wac plug");
      v.detail = `40 post-pump export calls; accept parked across a handshake and woken`;
    });

    // -- 5 -------------------------------------------------------------------
    await scenario(5, "stream terminal outcomes: reset and close, never a clean FIN", async (v) => {
      let r: TerminalReport | undefined;
      let lastError = "";
      let panics = 0;
      for (let attempt = 1; attempt <= ECHO_ATTEMPTS && !r; attempt++) {
        takeGuestPanics();
        try {
          r = await terminalProbeOnce(relay);
          await settle();
          panics += takeGuestPanics().length;
          if (attempt > 1 || panics > 0) {
            v.notes.push(
              `completed on attempt ${attempt}/${ECHO_ATTEMPTS}; ` +
                `${panics} guest panic(s) (RefCell borrow hazard)`,
            );
          }
        } catch (err) {
          lastError = describeError(err);
          panics += takeGuestPanics().length;
          console.log(`  attempt ${attempt}/${ECHO_ATTEMPTS} failed: ${lastError}`);
          await settle(100);
        }
      }
      if (!r) throw new Error(`no attempt completed; last: ${lastError}`);
      check(v, r.reset === "reset(77)", `read surfaced the peer reset: ${r.reset}`);
      check(v, r.resetLatched === "reset(77)", `the reset outcome is latched: ${r.resetLatched}`);
      check(
        v,
        r.closed === "closed",
        `a close under an unfinished stream reads as error.closed: ${r.closed}`,
      );
      check(
        v,
        r.closeInfo === '(9, "cut")',
        `wait-closed still carries the close after the failed read: ${r.closeInfo}`,
      );
      v.detail = `reset(77) latched; close read as ${r.closed} with close-info ${r.closeInfo}`;
    });

    // -- 6 -------------------------------------------------------------------
    await scenario(
      6,
      "idle survival: a quiet connection outlives the 30s idle timeout",
      async (v) => {
        let r: IdleReport | undefined;
        let lastError = "";
        let panics = 0;
        for (let attempt = 1; attempt <= ECHO_ATTEMPTS && !r; attempt++) {
          takeGuestPanics();
          try {
            r = await idleProbeOnce(relay);
            await settle();
            panics += takeGuestPanics().length;
            if (attempt > 1 || panics > 0) {
              v.notes.push(
                `completed on attempt ${attempt}/${ECHO_ATTEMPTS}; ` +
                  `${panics} guest panic(s) (RefCell borrow hazard)`,
              );
            }
          } catch (err) {
            lastError = describeError(err);
            panics += takeGuestPanics().length;
            console.log(`  attempt ${attempt}/${ECHO_ATTEMPTS} failed: ${lastError}`);
            await settle(100);
          }
        }
        if (!r) throw new Error(`no attempt completed; last: ${lastError}`);
        check(
          v,
          r.clientState === "open" && r.serverState === "open",
          `both connections outlived ${IDLE_HOLD_MS} ms of silence ` +
            `(client ${r.clientState}, server ${r.serverState})`,
        );
        check(v, r.echoed === MESSAGE.toUpperCase(), "a post-idle echo round-trip completed");
        check(v, r.path === "relay", "the idle window rode the relay wire");
        check(v, r.clientCloseInfo === undefined, "the closing side's wait-closed reports none");
        check(
          v,
          r.serverCloseInfo !== undefined && r.serverCloseInfo.code === CLOSE_CODE &&
            r.serverCloseInfo.reason === CLOSE_REASON,
          `the server read the client's application close after the idle window: ` +
            (r.serverCloseInfo
              ? `(${r.serverCloseInfo.code}, ${JSON.stringify(r.serverCloseInfo.reason)})`
              : "none"),
        );
        v.detail = `idle ${
          (IDLE_HOLD_MS / 1000).toFixed(0)
        } s on the relay path, then a clean echo and close`;
      },
    );

    // -- 7 -------------------------------------------------------------------
    await scenario(
      7,
      "relay outage: the connection survives it and the endpoint stays usable",
      async (v) => {
        if (!relay.owned) {
          v.status = "BLOCKED";
          v.detail = "the relay was pre-existing and adopted, so this run cannot stop it";
          return;
        }
        let r: OutageReport | undefined;
        let lastError = "";
        // Two attempts only: each costs the full outage in wall time,
        // and the two handshakes it runs lose the RefCell race rarely.
        const attempts = 2;
        for (let attempt = 1; attempt <= attempts && !r; attempt++) {
          takeGuestPanics();
          try {
            r = await outageProbeOnce(relayControl);
          } catch (err) {
            lastError = describeError(err);
            console.log(`  attempt ${attempt}/${attempts} failed: ${lastError}`);
            // The relay is left running whatever the attempt did with it.
            if (!await portListening(RELAY_PORT)) await relayControl.start();
            await settle(100);
          }
        }
        if (!r) throw new Error(`no attempt completed; last: ${lastError}`);
        if (r.priorPanics > 0) {
          v.notes.push(`${r.priorPanics} guest panic(s) before teardown (RefCell borrow hazard)`);
        }
        check(v, r.preEcho === MESSAGE.toUpperCase(), "a pre-outage echo round-trip completed");
        check(v, r.prePath === "relay", "the connection rode the relay wire");
        check(v, r.wentDown, `the relay stopped accepting on ${RELAY_PORT}`);
        check(
          v,
          r.clientState === "open" && r.serverState === "open",
          `both connections outlived ${OUTAGE_HOLD_MS} ms without a relay ` +
            `(client ${r.clientState}, server ${r.serverState})`,
        );
        check(
          v,
          r.postEcho === MESSAGE.toUpperCase(),
          `an echo completed after the relay returned (${r.recoveryMs.toFixed(0)} ms)`,
        );
        check(
          v,
          r.freshEcho === MESSAGE.toUpperCase(),
          "a FRESH dial on the same endpoints succeeded after the outage",
        );
        check(
          v,
          r.teardownPanics.length === 0,
          `no guest trap closing the endpoints with redials in flight ` +
            `(${r.teardownPanics.join("; ")})`,
        );
        v.detail = `survived ${(OUTAGE_HOLD_MS / 1000).toFixed(0)} s without a relay; ` +
          `echo back ${r.recoveryMs.toFixed(0)} ms after it returned, then a fresh dial`;
      },
    );

    // -- 8 -------------------------------------------------------------------
    // Last by necessity: this scenario stops the relay every later
    // scenario would need.
    await scenario(8, "teardown: close + wait-closed, relay reaped", async (v) => {
      const inst = await newEndpointInstance({ label: "teardown" });
      const ep = await deadline(
        bindEndpoint(inst, { alpns: [ALPN], relayUrl: relay.url, webrtc: false }),
        30_000,
        "bind",
      );
      await deadline(ep.close(), 10_000, "endpoint close");
      // Idempotent per wit/iroh.wit ("Idempotent. Dropping the resource
      // without calling `close` implies `close`.").
      await deadline(ep.close(), 10_000, "endpoint close (again)");
      ep.drop();
      await settle(200);
      const panics = takeGuestPanics();
      check(v, panics.length === 0, `no guest trap during teardown (${panics.join("; ")})`);

      await relay.stop();
      const reaped = !(await portListening(RELAY_PORT));
      check(
        v,
        reaped || relayWasAdopted,
        relayWasAdopted
          ? "the relay was pre-existing and adopted, so this run does not own its lifetime"
          : "iroh-relay --dev was reaped",
      );
      v.detail = relayWasAdopted
        ? "endpoint closed; relay adopted (not owned)"
        : "endpoint closed; relay reaped";
    });
  } finally {
    await relay.stop();
  }

  // -- verdict ---------------------------------------------------------------
  console.log("\n=== verdict ===");
  let failed = 0;
  for (const v of verdicts_()) {
    console.log(`  ${v.status.padEnd(7)} ${v.n}. ${v.name}${v.detail ? ` — ${v.detail}` : ""}`);
    if (v.status === "FAIL") failed++;
  }
  const blocked = verdicts_().filter((v) => v.status === "BLOCKED").length;
  console.log(
    failed === 0
      ? `EXAM PASS (${verdicts_().length - blocked} pass, ${blocked} blocked, 0 fail)`
      : `EXAM FAIL (${failed} failing scenario(s))`,
  );
  return failed === 0 ? 0 : 1;
}

function hexBytes(text: string): Uint8Array {
  return new Uint8Array((text.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
}

async function portListening(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

let relayWasAdopted = false;

if (import.meta.main) {
  relayWasAdopted = await portListening(RELAY_PORT);
  const code = await main();
  // node-datachannel's Node-API addon keeps handles alive after the guest has
  // dropped every peer connection, so the process would linger. Exiting
  // explicitly is the documented exemption (the webrtc host module's own
  // discipline).
  Deno.exit(code);
}
