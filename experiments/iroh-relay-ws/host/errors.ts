// Render an error for a log line, unwrapping polyengine's branded
// `ComponentException<{kind, value?}>` payloads (the sibling host modules
// throw these).

import { ComponentException } from "@polyengine/protocol";

export function describeErr(err: unknown): string {
  if (err instanceof ComponentException) {
    const p = err.payload as { kind?: string; value?: unknown } | undefined;
    if (p !== undefined && typeof p === "object" && "kind" in (p as object)) {
      return `${p.kind}${p.value === undefined ? "" : `(${String(p.value)})`}`;
    }
    return `ComponentException(${String(p)})`;
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
