// Render an error for a log line, unwrapping deltic's branded WIT error
// payloads (the sibling host modules throw `WitError<{tag, val?}>`).

import { WitError } from "@deltic/runtime/embedder";

export function describeErr(err: unknown): string {
  if (err instanceof WitError) {
    const p = err.payload as { tag?: string; val?: unknown } | undefined;
    if (p !== undefined && typeof p === "object" && "tag" in (p as object)) {
      return `${p.tag}${p.val === undefined ? "" : `(${String(p.val)})`}`;
    }
    return `WitError(${String(p)})`;
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
