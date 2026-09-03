// The "wire protocol" for the phone-QR-scan preview feature: what every WebSocket message
// relayed between the creator's tab (host) and the phone reader (viewer) via the relay (an
// independently deployed Cloudflare Worker + Durable Object, see ../../relay/README.md) looks
// like. This file only describes "the wire" - no UI, no WebSocket connection-establishment
// logic, no relay forwarding/validation implementation; those are each caller's own concern.
//
// File-location boundary decision:
//   - The web app (the code for both the story-creation page and the phone reader page) imports
//     this file directly and in full - both the types and the runtime validation functions below
//     get used. When the host side creates a session it calls generateHostKey()/
//     deriveViewerToken()/deriveSid() below directly - these three functions are the single
//     authoritative implementation of credential derivation; do not rewrite a separate hashing
//     implementation on the web-app side (rewriting it risks a "the two sides compute a
//     different sid" bug that can never connect).
//   - relay (an independent package, see ../../relay/) imports this file with a relative,
//     type-only import: relay's source tree must not depend on the web app's src/** runtime
//     code (independent deployment, independent lifecycle - it must not be forced to rebuild/
//     retest just because the web app changed something unrelated), but both sides must share
//     one authoritative type definition of "what the wire looks like" that they can check
//     against each other at compile time. That means relay has its own *independently
//     implemented* mirror copy of the runtime validation logic, constants, and credential
//     hash-chain verification logic (relay/src/protocol-limits.ts, relay/src/validate.ts,
//     relay/src/crypto.ts) - not laziness about sharing code, but a deliberate runtime
//     decoupling; whenever a maintainer changes this file's message shapes, constants, or
//     hash-chain algorithm, they must check the mirror copy in relay in lockstep (relay's file
//     headers there link back to this comment).
//
// This file itself must follow the dependency red line in docs/architecture.md (it lives in
// src/**): the only import allowed is the same-directory ./snapshot.ts (pure types + constants,
// likewise zero dependencies). The credential-derivation functions below use Web Crypto
// (`crypto.getRandomValues`/`crypto.subtle.digest`) and `btoa` - these are standard Web
// Platform APIs natively provided by both browsers and Cloudflare Workers (workerd), not Node
// built-in modules, so they do not violate the dependency red line (the red line bans imports,
// not use of global APIs; this file already uses global APIs like JSON.parse). The target
// runtime environments are explicitly "browser" and "Workers" - the two places that use this
// protocol - not a claim that it runs in any JS environment whatsoever.
//
// The shape of snapshot-manifest's story/images fields is not defined by this file: it is
// exactly ./snapshot.ts's PreviewSnapshot (decision: the creator's local preview and the
// phone-QR-scan preview must share the same "currently readable story" shape; relay is just a
// second transport for this shape, and should not define its own separate story
// representation). PreviewSnapshot already carries images metadata (id/mime/byteLength), so the
// snapshot-manifest message does not need to carry a separate images array again - the image
// bytes themselves are still sent chunk by chunk via image-chunk; the manifest only carries
// "which images exist, how big are they."
//
// ---------------------------------------------------------------------------
// Credential design: a hash chain, not a single shared token
// ---------------------------------------------------------------------------
// The original design had host/viewer share the same token: relay would remember "the token
// the host sent in its first hello" and later compare it against the token the viewer sends.
// Under the "zero storage" premise this design has a hole: a DO instance can be reclaimed by
// the runtime at any time once it has no connections/timers left, and after reclamation, the
// same sid connecting again is a brand-new instance that has no memory of "who has already used
// this token, who it's bound to." So anyone who has ever obtained the viewer's copy of the
// token (which circulates publicly - in the QR code / URL fragment) can, once the DO gets
// reclaimed, send {role:"host", token} to the new instance and impersonate the host - this is
// not a theoretical risk, it directly breaks this feature's core trust assumption ("only the
// creator can supply content").
//
// The fix: the host holds one more key that "only it itself knows"; what the viewer gets is
// only a one-way hash of that key, and the hashed value **cannot** be reversed back into the
// key. The full chain:
//
//   hostKey  = base64url(32 bytes crypto.getRandomValues)              - 43 characters
//   viewerToken = base64url(sha256(utf8(hostKey)))                     - 43 characters
//   sid      = hex(sha256(utf8(viewerToken)))                          - 64 characters
//
// hostKey **lives only in the creator's tab's memory, and never goes into the QR code/URL/
// anything sent to the phone**. The QR code/URL fragment carries viewerToken. sid is purely a
// public routing alias (see the "DO routing" section below for why); host and viewer each
// compute it independently, and both send `/session?sid=<sid>` when connecting.
//
// relay validation (see relay/src/session-do.ts):
//   - host sends hello{role:"host", hostKey} -> relay recomputes viewerToken' and sid' from
//     hostKey; it must equal this connection's URL sid, otherwise invalid-token (only this new
//     connection is closed; it does not affect an existing host/viewer).
//   - viewer sends hello{role:"viewer", token} -> relay recomputes sid' from token; it must
//     equal this connection's URL sid, otherwise invalid-token.
//
// This validation **needs relay to remember no prior state at all** - sid itself is the anchor
// for validation, and it validates just as well even if the DO gets reclaimed and a brand-new
// instance takes over, because validation is only a pure-function check of "does this
// hostKey/token, when hashed, equal the sid I'm currently routed to." This is exactly the
// "credential that can be validated without memory state" this design calls for.
//
// Result: someone who only has the viewerToken (say, they glimpsed the QR code on someone
// else's phone screen, or found the URL fragment in browser history) cannot compute hostKey,
// and can never pass host-hello validation - at most they can connect as a viewer and wait for
// approval. With no live host tab, a viewer waits forever and never gets any content
// (host-offline). For an honest account of what happens once the DO is reclaimed, see the
// header of relay/src/session-do.ts and the "Zero storage" section of relay/README.md - it is
// not a loose analogy like "equivalent to the TTL expiring," it is the explicit fact that
// "without hostKey, becoming the host again is impossible."
//
// ---------------------------------------------------------------------------
// Overview of roles and the pairing flow (full flow is the state-machine diagram in
// relay/README.md):
//   1. The host tab calls generateHostKey()/deriveViewerToken()/deriveSid() to compute these
//      three values, opens a WebSocket to the relay's `/session?sid=<sid>`, and the **first
//      message** after connecting is {type:"hello", role:"host", hostKey} -> once relay
//      verifies the hash chain, it remembers this connection as the host and replies
//      {type:"host-ready", pairingCode} (a 4-digit number, generated by relay, for humans to
//      cross-check by eye).
//   2. The viewer (which got viewerToken from the QR code/URL fragment) calls deriveSid() to
//      compute the same sid, opens another WebSocket to the same `/session?sid=<sid>`, and its
//      first message is {type:"hello", role:"viewer", token: viewerToken} -> relay forwards a
//      {type:"pair-request"} to the host, and replies to the viewer with
//      {type:"awaiting-approval", pairingCode}.
//   3. The host sends {type:"pair-approve"} or {type:"pair-reject"} depending on whether the
//      user approves (both are forwarded verbatim to the viewer). After an approve, this
//      viewerToken is immediately consumed - a second viewer with the same viewerToken is
//      always rejected (token-consumed); a reject does not consume the viewerToken, and the
//      host can keep waiting for the next pairing attempt.
//   4. Once paired, the viewer sends {type:"snapshot-request"} (forwarded to the host), the
//      host replies with a {type:"snapshot-manifest"} (the story structure + metadata for each
//      image), then sends {type:"image-chunk"} one at a time, and finally
//      {type:"snapshot-complete"}. relay only forwards these messages verbatim; it never parses
//      the story content.
//   5. If any validation step fails, or there is a timeout or disconnect, relay sends a
//      {type:"error", code} message and then closes the WebSocket (see PREVIEW_ERROR_CLOSE_CODE
//      below for the close-code table). When the host disconnects, the viewer additionally
//      receives {type:"host-offline"}; when the TTL expires, both sides receive
//      {type:"session-expired"}.
//
// The choice of binary transport: image-chunk encodes the image bytes as a base64 string, wrapped in the same JSON
// envelope as every other message, instead of using WebSocket's native binary frame. Reasons:
//   - relay's job is to "validate only the outer shape, never parse the content" - if images
//     went over a binary frame, relay would either have to skip validating that frame entirely
//     (giving up the size cap / sequence-number checks) or invent a separate two-frame protocol
//     that correlates "a JSON header sent first, immediately followed by a binary frame," which
//     only adds new protocol-violation edge cases like "the header and binary frame get out of
//     order" or "a binary frame with no matching header." base64-in-JSON makes every
//     image-chunk a self-describing message whose shape can be validated independently,
//     handled by the same logic as every other message type.
//   - The tradeoff is bandwidth (base64 inflates size by about 4/3) - acceptable: this is a
//     low-frequency, manually-triggered feature for previewing a single story, not a
//     high-volume batch image pipeline; the per-image cap is 5 MiB and the whole-batch cap is
//     20 MiB (see the constants below), and even after inflation that stays well under the
//     Workers runtime's 32 MiB limit on a single WebSocket message.
//
// Technical constraints on DO routing and how they're handled (although this belongs to relay's routing layer, it is recorded here
// too because it directly drives this protocol file's field design): Cloudflare's WebSocket
// object cannot be handed off between two Durable Objects via RPC (per the official docs, RPC
// can only pass structured-clone-compatible values / ReadableStream / RpcTarget, and WebSocket
// is not among them) - in other words, the decision of "which DO instance ultimately handles
// this WebSocket connection" must be made at the moment of the HTTP upgrade (i.e. before the
// first WebSocket message arrives), and cannot wait until after receiving the credentialed
// hello to "hand off" to the correct DO. hostKey/viewerToken themselves
// must not appear in the URL path/query. The solution: before opening the WebSocket, host/viewer
// each compute sid = deriveSid(viewerToken) (the host side first derives viewerToken from
// hostKey, then computes sid), and send `?sid=<sid>` when connecting. sid is "a public alias for
// routing," not the credential itself - it is a one-way hash of viewerToken, and having sid
// cannot be reversed back into viewerToken, let alone hostKey (fail-closed: having only the sid
// cannot connect into any real session; the actual pairing validation is still the hash-chain
// comparison), so putting sid into the URL/query (which may end up in a CDN's or browser's
// access logs) does not violate the spirit of "credentials never hit a log." On the relay side,
// sid maps to the Durable Object's name (`env.SESSION.getByName(sid)`).

import type { PreviewImageMime, PreviewSnapshot } from "./snapshot.ts";
import { PREVIEW_LIMITS } from "./snapshot.ts";

/** The two connection roles: host = the creator's tab (the source of story data),
 * viewer = the phone reader. */
export type PreviewRole = "host" | "viewer";

/** A closed set, reused by isPreviewRole() and the other validation functions instead of each
 * enumerating it separately. */
export const PREVIEW_ROLES: readonly PreviewRole[] = ["host", "viewer"];

/** A closed enum of error codes - codes only, no free text attached; the UI side decides what
 * localized copy to show for each code. */
export const PREVIEW_ERROR_CODES = [
  "invalid-token",
  "token-consumed",
  "not-paired",
  "host-offline",
  "session-expired",
  "too-large",
  "protocol-violation",
  "rate-limited",
] as const;
export type PreviewErrorCode = (typeof PREVIEW_ERROR_CODES)[number];

/** The WebSocket close code for each error code (RFC 6455 reserves 4000-4999 for
 * application-defined use). The host-offline/session-expired values (4001/4002) were chosen
 * deliberately; the rest were chosen while implementing relay, and are all
 * collected here so neither side (relay's close calls, the web app's onclose handling) needs
 * to hard-code its own lookup table. */
export const PREVIEW_ERROR_CLOSE_CODE: Record<PreviewErrorCode, number> = {
  "host-offline": 4001,
  "session-expired": 4002,
  "protocol-violation": 4003,
  "invalid-token": 4004,
  "token-consumed": 4005,
  "not-paired": 4006,
  "too-large": 4007,
  "rate-limited": 4008,
};

// ---------------------------------------------------------------------------
// Size/time limit constants - collected here because relay and the web app must agree on the
// same numbers for "too big / too long." relay has an independent mirror copy (see the file
// header); when a value changes, update both sides together.
// ---------------------------------------------------------------------------

/** The size cap for a single image (raw bytes, before base64 encoding) - the stricter of the
 * transport-layer cap (5 MiB) and ./snapshot.ts's PREVIEW_LIMITS.maxImageBytes, so that when
 * either side is tuned in the future it can never accidentally loosen the cap the other side
 * already tightened. */
export const MAX_IMAGE_BYTES = Math.min(5 * 1024 * 1024, PREVIEW_LIMITS.maxImageBytes);
/** The cap on the sum of all image bytes (raw, before encoding) in one snapshot; taking the
 * stricter value for the same reason as above. */
export const MAX_SNAPSHOT_TOTAL_BYTES = Math.min(20 * 1024 * 1024, PREVIEW_LIMITS.maxTotalImageBytes);
/** The raw-byte cap (before encoding) for a single image-chunk. */
export const MAX_CHUNK_BYTES = 32 * 1024; // 32 KiB
/** The max character length that byte cap above corresponds to once base64-encoded (accounting
 * for 4/3 inflation and up to 2 padding characters): ceil(bytes/3)*4. Used to reject an
 * over-length string before ever base64-decoding it. */
export const MAX_CHUNK_BASE64_LENGTH = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;
/** The overall size cap for a snapshot-manifest message (as a serialized JSON string). */
export const MAX_MANIFEST_JSON_BYTES = 256 * 1024; // 256 KiB
/** The message-rate cap for a single WebSocket connection: at most this many messages per
 * RATE_LIMIT_WINDOW_MS milliseconds (a per-connection counter,
 * not one counter shared across the whole session - see the dispatch-rule notes in
 * relay/src/session-do.ts's file header). */
export const RATE_LIMIT_MAX_MESSAGES = 200;
export const RATE_LIMIT_WINDOW_MS = 10_000;

/** How long a session stays alive before pairing (host connected, waiting for the viewer to
 * complete pairing). */
export const PAIRING_TTL_MS = 5 * 60_000;
/** After pairing, how long the session stays alive while idle with no messages exchanged
 * (any message resets this timer). */
export const IDLE_TTL_MS = 10 * 60_000;
/** The absolute lifetime cap for the whole session, counted from the moment the host connects;
 * it is never extended by activity. */
export const ABSOLUTE_TTL_MS = 60 * 60_000;
/** How long a WebSocket connection is allowed to stay open before it sends a (valid) first
 * hello - this prevents someone from opening many connections and holding them open without
 * ever sending anything. */
export const PRE_AUTH_TIMEOUT_MS = 10_000;

/** The one-time pairing code: a 4-digit number for humans to cross-check by eye (this is not
 * the security boundary itself - the security boundary is the hash-chain credential; the
 * pairing code is only a visual confirmation for the user that "are these two devices
 * connected to the same pairing request"). */
export const PAIRING_CODE_PATTERN = /^\d{4}$/;

/** The shape of hostKey/viewerToken: a base64url encoding of 32 bytes (no padding), a fixed
 * 43 characters (previously only an upper bound was checked, with no lower
 * bound / exact-length check; this matches the pattern exactly, fixing both issues at
 * once). */
export const HOST_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const VIEWER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** The shape of sid: a hex encoding of a sha256 digest, a fixed 64 lowercase hex characters. */
export const SID_PATTERN = /^[0-9a-f]{64}$/;

export const MAX_IMAGE_ID_LENGTH = 128;
/** The string-length cap for the id-type fields of PreviewStory/PreviewPage (page id,
 * startPageId, choice target, the page.imageId reference) - ./snapshot.ts does not specify one
 * separately, so this picks a generous but bounded value, purely as a fail-closed "cannot be
 * unbounded length" guard, not a slug-format validation. */
export const MAX_PAGE_ID_LENGTH = 128;
/** The string-length cap for story.title / page.title, for the same reason as above. */
export const MAX_TITLE_LENGTH = 200;
/** ./snapshot.ts's PreviewImageMime is a closed enum; this lists the same set of values for a
 * fail-closed membership check (the type itself cannot be checked at runtime, only this array
 * can). */
const PREVIEW_IMAGE_MIME_VALUES: readonly PreviewImageMime[] = ["image/png", "image/jpeg", "image/webp"];

// ---------------------------------------------------------------------------
// Credential-derivation functions - all three parties (host, viewer, and relay) must compute
// the same set of values; this is the single authoritative implementation (relay's mirror copy
// is in relay/src/crypto.ts, see the file header's "file-location boundary decision"). The
// three functions together form the hash chain described in the "Credential design" section
// above.
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Utf8ToBase64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

async function sha256Utf8ToHex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generates a fresh hostKey - 32 bytes of cryptographically secure random data, base64url
 * encoded. The caller (the host tab) must keep this value safe and never let it leak (not
 * into the QR code, not into the URL, not sent to anyone) - what leaks out is the viewerToken
 * computed by deriveViewerToken() below, not this. */
export function generateHostKey(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** hostKey -> viewerToken (one-way hash, irreversible). Called once when the host tab creates
 * a session; later, whenever the host side itself needs to recompute sid, it calls this first
 * and then calls deriveSid(). */
export async function deriveViewerToken(hostKey: string): Promise<string> {
  return sha256Utf8ToBase64Url(hostKey);
}

/** viewerToken -> sid (one-way hash, irreversible). The host side passes in its own computed
 * viewerToken; the viewer side passes in the viewerToken it got straight from the QR
 * code/URL fragment - both sides compute the same sid, so relay can route them to the same
 * Durable Object instance. */
export async function deriveSid(viewerToken: string): Promise<string> {
  return sha256Utf8ToHex(viewerToken);
}

// ---------------------------------------------------------------------------
// Message types: what a client (host or viewer) sends to relay, and what relay sends to a
// client, are kept as two separate unions - even though the three message types
// snapshot-manifest/image-chunk/snapshot-complete look identical in both directions (relay
// forwards them verbatim, unchanged), they still each appear in both unions, to honestly
// reflect the directionality of "the host sends it, relay forwards it to the viewer" rather
// than pretending there is one undirected set of messages.
// ---------------------------------------------------------------------------

/** The host's version of hello - carries hostKey (the key only the host itself knows). */
export interface HostHelloMessage {
  readonly type: "hello";
  readonly role: "host";
  readonly hostKey: string;
}

/** The viewer's version of hello - carries token (i.e. viewerToken, the value that circulates
 * publicly in the QR code/URL fragment). The field is deliberately still named `token` (not
 * `viewerToken`) - it is the only credential field the viewer ever uses, and the wire does not
 * need the field name to distinguish "which kind of token this is"; role already does that. */
export interface ViewerHelloMessage {
  readonly type: "hello";
  readonly role: "viewer";
  readonly token: string;
}

/** hello splits into two shapes by role - host carries
 * hostKey, viewer carries token, and the two have different hash-chain validation paths (see
 * "Credential design" above); cramming two semantically different fields into one shared shape
 * would only make runtime validation ambiguous. */
export type HelloMessage = HostHelloMessage | ViewerHelloMessage;

export interface PairApproveMessage {
  readonly type: "pair-approve";
}

export interface PairRejectMessage {
  readonly type: "pair-reject";
}

export interface SnapshotRequestMessage {
  readonly type: "snapshot-request";
}

export interface SnapshotManifestMessage {
  readonly type: "snapshot-manifest";
  /** ./snapshot.ts's PreviewSnapshot - images only carries metadata (id/mime/byteLength); the
   * actual bytes are sent chunk by chunk in the image-chunk messages that follow. To relay,
   * this whole field is an opaque value (relay only validates the serialized message's overall
   * size and the byte counts images claims, and never parses the story content). */
  readonly snapshot: PreviewSnapshot;
}

export interface ImageChunkMessage {
  readonly type: "image-chunk";
  readonly id: string;
  readonly index: number;
  readonly total: number;
  readonly dataBase64: string;
}

export interface SnapshotCompleteMessage {
  readonly type: "snapshot-complete";
}

export type ClientToRelayMessage =
  | HelloMessage
  | PairApproveMessage
  | PairRejectMessage
  | SnapshotRequestMessage
  | SnapshotManifestMessage
  | ImageChunkMessage
  | SnapshotCompleteMessage;

export interface HostReadyMessage {
  readonly type: "host-ready";
  readonly pairingCode: string;
}

export interface PairRequestMessage {
  readonly type: "pair-request";
}

export interface AwaitingApprovalMessage {
  readonly type: "awaiting-approval";
  readonly pairingCode: string;
}

export interface PreviewErrorMessage {
  readonly type: "error";
  readonly code: PreviewErrorCode;
}

export interface HostOfflineMessage {
  readonly type: "host-offline";
}

export interface SessionExpiredMessage {
  readonly type: "session-expired";
}

export type RelayToClientMessage =
  | HostReadyMessage
  | PairRequestMessage
  | AwaitingApprovalMessage
  | PairApproveMessage
  | PairRejectMessage
  | SnapshotManifestMessage
  | ImageChunkMessage
  | SnapshotCompleteMessage
  | PreviewErrorMessage
  | HostOfflineMessage
  | SessionExpiredMessage;

// ---------------------------------------------------------------------------
// Runtime validation functions - every message has a
// runtime validation function, and any bad shape (null, an array, a missing field, an
// over-length string, an illegal code) must fail-closed. Every isXxx() returns false for
// null/undefined/an array/a missing field/a wrong type/an over-length string, and never throws
// - callers (relay's message-envelope validation, the web app's defensive checks when it
// receives a relay message) can use it directly as a boolean without wrapping try/catch. These
// functions only validate "shape" (a field exists, has the right type, and matches the
// length/pattern) - whether the hash chain itself is actually valid (whether hostKey really
// hashes to this sid) is asynchronous (crypto.subtle.digest) and does not belong at this
// layer; that is something the caller (relay's session-do.ts) does separately, using
// deriveViewerToken()/deriveSid() above.
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isBoundedString(x: unknown, maxLength: number): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= maxLength;
}

function isNonNegativeInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}

function matchesPattern(x: unknown, pattern: RegExp): x is string {
  return typeof x === "string" && pattern.test(x);
}

// base64 character set + length must be a multiple of 4 (allowing 0-2 trailing padding
// characters). This is only a "shape" check (fail-closed against strings that obviously are
// not base64); it does not guarantee that the decoded byte count actually matches what the
// caller claims - that is left for relay itself to check after decoding (see the validation
// in relay/src).
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
function isBase64String(x: unknown, maxLength: number): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= maxLength && x.length % 4 === 0 && BASE64_RE.test(x);
}

export function isPreviewRole(x: unknown): x is PreviewRole {
  return x === "host" || x === "viewer";
}

export function isPreviewErrorCode(x: unknown): x is PreviewErrorCode {
  return typeof x === "string" && (PREVIEW_ERROR_CODES as readonly string[]).includes(x);
}

export function isPairingCode(x: unknown): x is string {
  return typeof x === "string" && PAIRING_CODE_PATTERN.test(x);
}

export function isSid(x: unknown): x is string {
  return matchesPattern(x, SID_PATTERN);
}

export function isHostHelloMessage(x: unknown): x is HostHelloMessage {
  return isPlainObject(x) && x.type === "hello" && x.role === "host" && matchesPattern(x.hostKey, HOST_KEY_PATTERN);
}

export function isViewerHelloMessage(x: unknown): x is ViewerHelloMessage {
  return isPlainObject(x) && x.type === "hello" && x.role === "viewer" && matchesPattern(x.token, VIEWER_TOKEN_PATTERN);
}

export function isHelloMessage(x: unknown): x is HelloMessage {
  return isHostHelloMessage(x) || isViewerHelloMessage(x);
}

export function isPairApproveMessage(x: unknown): x is PairApproveMessage {
  return isPlainObject(x) && x.type === "pair-approve";
}

export function isPairRejectMessage(x: unknown): x is PairRejectMessage {
  return isPlainObject(x) && x.type === "pair-reject";
}

export function isSnapshotRequestMessage(x: unknown): x is SnapshotRequestMessage {
  return isPlainObject(x) && x.type === "snapshot-request";
}

/** ./snapshot.ts's PreviewImageMeta - note that this only validates the "metadata shape," not
 * the image bytes themselves (those travel via image-chunk, see isImageChunkMessage below). */
export function isPreviewImageMeta(x: unknown): x is import("./snapshot.ts").PreviewImageMeta {
  return (
    isPlainObject(x) &&
    isBoundedString(x.id, MAX_IMAGE_ID_LENGTH) &&
    (PREVIEW_IMAGE_MIME_VALUES as readonly unknown[]).includes(x.mime) &&
    isNonNegativeInt(x.byteLength) &&
    x.byteLength > 0 &&
    x.byteLength <= MAX_IMAGE_BYTES
  );
}

export function isPreviewChoice(x: unknown): x is import("./snapshot.ts").PreviewChoice {
  return isPlainObject(x) && isBoundedString(x.label, PREVIEW_LIMITS.maxLabelChars) && isBoundedString(x.target, MAX_PAGE_ID_LENGTH);
}

export function isPreviewPage(x: unknown): x is import("./snapshot.ts").PreviewPage {
  if (!isPlainObject(x)) return false;
  if (!isBoundedString(x.id, MAX_PAGE_ID_LENGTH)) return false;
  if (x.title !== undefined && !isBoundedString(x.title, MAX_TITLE_LENGTH)) return false;
  // The text field allows an empty string (a page that hasn't been written yet) - it only
  // rejects "not a string" and "over-length," never "empty."
  if (typeof x.text !== "string" || x.text.length > PREVIEW_LIMITS.maxTextCharsPerPage) return false;
  if (x.imageId !== undefined && !isBoundedString(x.imageId, MAX_IMAGE_ID_LENGTH)) return false;
  if (!Array.isArray(x.choices) || x.choices.length > PREVIEW_LIMITS.maxChoicesPerPage) return false;
  if (!x.choices.every((c) => isPreviewChoice(c))) return false;
  if (x.next !== undefined && !isBoundedString(x.next, MAX_PAGE_ID_LENGTH)) return false;
  return true;
}

export function isPreviewStory(x: unknown): x is import("./snapshot.ts").PreviewStory {
  return (
    isPlainObject(x) &&
    isBoundedString(x.title, MAX_TITLE_LENGTH) &&
    isBoundedString(x.startPageId, MAX_PAGE_ID_LENGTH) &&
    Array.isArray(x.pages) &&
    x.pages.length > 0 &&
    x.pages.length <= PREVIEW_LIMITS.maxPages &&
    x.pages.every((p) => isPreviewPage(p))
  );
}

export function isPreviewSnapshot(x: unknown): x is PreviewSnapshot {
  if (!isPlainObject(x)) return false;
  if (!isPreviewStory(x.story)) return false;
  if (!Array.isArray(x.images) || !x.images.every((img) => isPreviewImageMeta(img))) return false;
  if (!isNonNegativeInt(x.revision)) return false;
  const totalBytes = (x.images as readonly { byteLength: number }[]).reduce((sum, img) => sum + img.byteLength, 0);
  return totalBytes <= MAX_SNAPSHOT_TOTAL_BYTES;
}

export function isSnapshotManifestMessage(x: unknown): x is SnapshotManifestMessage {
  return isPlainObject(x) && x.type === "snapshot-manifest" && isPreviewSnapshot(x.snapshot);
}

export function isImageChunkMessage(x: unknown): x is ImageChunkMessage {
  return (
    isPlainObject(x) &&
    x.type === "image-chunk" &&
    isBoundedString(x.id, MAX_IMAGE_ID_LENGTH) &&
    isNonNegativeInt(x.index) &&
    isNonNegativeInt(x.total) &&
    x.total > 0 &&
    x.index < x.total &&
    isBase64String(x.dataBase64, MAX_CHUNK_BASE64_LENGTH)
  );
}

export function isSnapshotCompleteMessage(x: unknown): x is SnapshotCompleteMessage {
  return isPlainObject(x) && x.type === "snapshot-complete";
}

export function isClientToRelayMessage(x: unknown): x is ClientToRelayMessage {
  if (!isPlainObject(x) || typeof x.type !== "string") return false;
  switch (x.type) {
    case "hello":
      return isHelloMessage(x);
    case "pair-approve":
      return isPairApproveMessage(x);
    case "pair-reject":
      return isPairRejectMessage(x);
    case "snapshot-request":
      return isSnapshotRequestMessage(x);
    case "snapshot-manifest":
      return isSnapshotManifestMessage(x);
    case "image-chunk":
      return isImageChunkMessage(x);
    case "snapshot-complete":
      return isSnapshotCompleteMessage(x);
    default:
      return false;
  }
}

export function isHostReadyMessage(x: unknown): x is HostReadyMessage {
  return isPlainObject(x) && x.type === "host-ready" && isPairingCode(x.pairingCode);
}

export function isPairRequestMessage(x: unknown): x is PairRequestMessage {
  return isPlainObject(x) && x.type === "pair-request";
}

export function isAwaitingApprovalMessage(x: unknown): x is AwaitingApprovalMessage {
  return isPlainObject(x) && x.type === "awaiting-approval" && isPairingCode(x.pairingCode);
}

export function isPreviewErrorMessage(x: unknown): x is PreviewErrorMessage {
  return isPlainObject(x) && x.type === "error" && isPreviewErrorCode(x.code);
}

export function isHostOfflineMessage(x: unknown): x is HostOfflineMessage {
  return isPlainObject(x) && x.type === "host-offline";
}

export function isSessionExpiredMessage(x: unknown): x is SessionExpiredMessage {
  return isPlainObject(x) && x.type === "session-expired";
}

export function isRelayToClientMessage(x: unknown): x is RelayToClientMessage {
  if (!isPlainObject(x) || typeof x.type !== "string") return false;
  switch (x.type) {
    case "host-ready":
      return isHostReadyMessage(x);
    case "pair-request":
      return isPairRequestMessage(x);
    case "awaiting-approval":
      return isAwaitingApprovalMessage(x);
    case "pair-approve":
      return isPairApproveMessage(x);
    case "pair-reject":
      return isPairRejectMessage(x);
    case "snapshot-manifest":
      return isSnapshotManifestMessage(x);
    case "image-chunk":
      return isImageChunkMessage(x);
    case "snapshot-complete":
      return isSnapshotCompleteMessage(x);
    case "error":
      return isPreviewErrorMessage(x);
    case "host-offline":
      return isHostOfflineMessage(x);
    case "session-expired":
      return isSessionExpiredMessage(x);
    default:
      return false;
  }
}

/** A safe JSON.parse - returns a Result instead of throwing, so the caller (relay, on every
 * WebSocket text message it receives) does not need to wrap it in try/catch itself. Bad JSON
 * is always treated as a signal for protocol-violation (it is up to the caller to decide
 * whether to actually close the connection with that code). */
export function tryParseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}
