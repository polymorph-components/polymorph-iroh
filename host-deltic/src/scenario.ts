// Scenario support: verdict bookkeeping, the guest-panic watchdog, and the
// stream helpers shared in shape with the former jco driver
// (host-jco/src/run-endpoint.mjs, removed with the jco host).

import { describeError, fromUtf8 } from "./harness.ts";
import type { RecvStream } from "./types.ts";

export type Status = "PENDING" | "PASS" | "FAIL" | "BLOCKED" | "SKIP";

export interface Verdict {
  readonly n: number;
  readonly name: string;
  status: Status;
  detail: string;
  readonly notes: string[];
}

const verdicts: Verdict[] = [];

export function verdicts_(): readonly Verdict[] {
  return verdicts;
}

export async function scenario(
  n: number,
  name: string,
  body: (v: Verdict) => Promise<void>,
): Promise<Verdict> {
  // Starts PENDING, not FAIL: the body is free to set `detail` (a metrics
  // line) without that being read as a failure. Only `check` and a thrown
  // error decide FAIL; a body may set BLOCKED/SKIP deliberately.
  const v: Verdict = { n, name, status: "PENDING" as Status, detail: "", notes: [] };
  verdicts.push(v);
  console.log(`\n=== scenario ${n}: ${name} ===`);
  const started = performance.now();
  try {
    await body(v);
    if (v.status === "PENDING") v.status = "PASS";
  } catch (err) {
    if (v.status === "PENDING" || v.status === "FAIL") {
      v.status = "FAIL";
      if (v.detail === "") v.detail = describeError(err);
      else v.detail = `${v.detail} | ${describeError(err)}`;
    }
  }
  const ms = (performance.now() - started).toFixed(0);
  console.log(`${v.status} scenario ${n} (${name}) [${ms} ms] ${v.detail}`);
  for (const note of v.notes) console.log(`  note: ${note}`);
  return v;
}

/** An assertion whose failure is the scenario's verdict, not a stack trace. */
export function check(v: Verdict, ok: boolean, what: string): void {
  if (ok) {
    console.log(`  ok: ${what}`);
    return;
  }
  v.status = "FAIL";
  v.detail = `assertion failed: ${what}`;
  throw new Error(`assertion failed: ${what}`);
}

// --- guest-panic watchdog ---------------------------------------------------
//
// A trap raised inside the endpoint's DETACHED PUMP task surfaces as an
// unhandled promise rejection: nothing in the host is awaiting that task.
// Left alone it kills the process, so the watchdog converts it into a
// recorded event that a retry loop can read. See run-endpoint.ts's note on
// the RefCell borrow hazard for what actually raises it.

let guestPanics: string[] = [];

export function installPanicWatchdog(): void {
  globalThis.addEventListener("unhandledrejection", (event) => {
    const reason = (event as unknown as { reason: unknown }).reason;
    const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    guestPanics.push(text);
    event.preventDefault();
  });
}

export function takeGuestPanics(): string[] {
  const taken = guestPanics;
  guestPanics = [];
  return taken;
}

export function sawGuestPanic(): boolean {
  return guestPanics.length > 0;
}

/** Let the microtask/timer queue turn so a pending trap rejection lands. */
export function settle(ms = 25): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- stream helpers (shape of the former host-jco endpoint driver) ----------

export const READ_MAX = 16 * 1024;

export async function readAll(recv: RecvStream): Promise<string> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = await recv.read(READ_MAX);
    if (chunk === undefined) break;
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    merged.set(c, at);
    at += c.length;
  }
  return fromUtf8.decode(merged);
}
