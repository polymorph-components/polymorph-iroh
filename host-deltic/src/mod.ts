/**
 * @polymorph/iroh — the iroh endpoint as a WebAssembly component,
 * runtime-linked under deltic.
 *
 * `newEndpointInstance()` stands up one endpoint instance over the sibling
 * `@polymorph` deltic host modules — webcrypto (identity keys), websocket
 * (relay transport), webrtc-datachannels (direct browser paths) — plus a
 * browser-profile `wasi:sockets` provider whose UDP surface answers
 * `not-supported` (the endpoint binds no socket when `udp-bind-addr` is
 * `none`). The packaged endpoint component ships in the module graph;
 * `componentBytes` swaps in a caller-supplied build.
 *
 * `bindEndpoint()` drives `polymorph:iroh/endpoint@0.1.0`'s
 * generate-identity → options → bind sequence and returns the bound
 * endpoint resource.
 */

export {
  bindEndpoint,
  deadline,
  describeError,
  type EndpointInstance,
  type EndpointInstanceOptions,
  fromUtf8,
  hex,
  IDENTITY_GENERATE_INTERFACE,
  IROH_ENDPOINT_INTERFACE,
  loadArtifacts,
  type LoadArtifactsOptions,
  newEndpointInstance,
  shortId,
  utf8,
} from "./harness.ts";
export { resetUdpCallLog, socketsImports, udpCallLog } from "./sockets.ts";
export type * from "./types.ts";
