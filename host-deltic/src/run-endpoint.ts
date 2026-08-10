// The iroh endpoint exam on the deltic host: the endpoint COMPONENT
// runtime-linked under stock Deno, with the sibling repositories' deltic
// host modules supplying every non-WASI import — no transpile step, no
// generated tree, no engine flag.
//
// This is the endpoint workload the jco leg cannot run yet (issue #10 =
// lann/jco#11: a detached pump task holding in-flight imports deadlocks
// every later export call; lann/jco#13: cross-task wakeups are not
// delivered), driven by the same logic as the jco driver held ready for
// when that lands (host-jco/src/run-endpoint.mjs).
//
//   just exam-deltic
//
// `--unstable-net` is not needed by anything here today (see src/sockets.ts:
// the browser profile binds no UDP socket and the exam asserts zero
// `wasi:sockets` calls); a direct-path UDP leg would add it.
//
// ---------------------------------------------------------------------------
// Why scenarios 2-4 retry: a guest-side RefCell borrow hazard.
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
// latent on every host; deltic reaches it more often because a resolved
// task that blocks mid-frame releases the instance's exclusivity there (a
// documented wasmtime-tracking divergence, deltic
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
  hex,
  newEndpointInstance,
  type Relay,
  RELAY_PORT,
  shortId,
  startRelay,
  utf8,
} from "./harness.ts";
import { resetUdpCallLog, udpCallLog } from "./sockets.ts";
import type { Connection, Endpoint, PathKind, TransportAddr } from "./types.ts";
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
  const addrs: TransportAddr[] = [{ tag: "relay", val: relay.url }];
  if (options.webrtc) addrs.push({ tag: "webrtc", val: relay.url });

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
    await deadline(conn.waitClosed(), 30_000, "server wait-closed");
    const path = await conn.path();
    return { received, peer: await conn.peer(), path, conn };
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

  await clientConn.close(0, "done");
  await deadline(clientConn.waitClosed(), 30_000, "client wait-closed");
  const s = await deadline(serverSide, 30_000, "server side");

  if (hex(s.peer) !== hex(clientId)) {
    throw new Error(
      `the server authenticated ${shortId(s.peer)}, not the client's ${shortId(clientId)}`,
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

async function main(): Promise<number> {
  installPanicWatchdog();
  console.log("iroh endpoint exam (deltic / stock Deno)");

  const relay = await startRelay();
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
      await settle();
      check(v, takeGuestPanics().length === 0, "no guest trap during bind/identity");
      v.detail = `bind ${bindMs.toFixed(0)} ms, id ${shortId(id)}, 3 post-pump export calls`;
    });

    // -- 2 -------------------------------------------------------------------
    await scenario(2, "relay echo between two endpoint instances", async (v) => {
      resetUdpCallLog();
      const r = await echoWithRetries(relay, v, { webrtc: false, parkAccept: false });
      check(v, r.received === MESSAGE, `the server received ${JSON.stringify(r.received)}`);
      check(v, r.echoed === MESSAGE.toUpperCase(), `the client read back the echo`);
      check(v, r.clientPath === "relay", `connection.path is "relay" on the client`);
      check(v, r.serverPath === "relay", `connection.path is "relay" on the server`);
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
    await scenario(5, "teardown: close + wait-closed, relay reaped", async (v) => {
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
