// The iroh-relay-ws spike's synthetic WASI network, shared (single
// evaluation via module cache; see run.sh's --config pointing at that
// spike's deno.json for the module-identity constraint this relies on).
export * from "../../iroh-relay-ws/host/sockets.ts";
