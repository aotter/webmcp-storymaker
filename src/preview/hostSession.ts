// Phone-QR-scan preview: the session logic for the creator's (host) side - "state machine +
// pure message-handling functions" and "a thin WebSocket wrapper" are deliberately split into
// two layers, for the same reason as the existing layering discipline in
// ./readerState.ts + ./reader.ts and ../ui/state.ts + ../ui/controller.ts: the large block
// below (HostSessionState, the applyXxx() family, chunkBytes()/buildImageChunkMessages(),
// checkSnapshotSize()) is entirely zero I/O, zero DOM, zero WebSocket - it can be fed a
// sequence of messages directly in tests, with no need to open a real connection. The only
// thing that actually touches WebSocket is the HostSession class at the end of the file, and
// it stays thin, doing only three things: open the connection and send hello, turn incoming
// messages into calls to the pure functions above, and actually send whatever message those
// pure functions decide to send. The instance is held by ../ui/controller.ts (see the note
// above the HostSession class below); it only calls the
// methods here and subscribes to its state changes, and never touches any protocol detail
// itself; ../preview/hostPanel.ts purely renders the state the controller exposes and never
// touches anything in this file directly.
//
// ---------------------------------------------------------------------------
// Which messages the host actually receives in this protocol (spelling this out first, since
// it determines the shape of the state machine below)
// ---------------------------------------------------------------------------
// Cross-referencing ../../relay/src/session-do.ts's forwarding rules and ./protocol.ts's
// RelayToClientMessage definition - over the whole session, relay only ever actually sends the
// host connection these kinds of messages:
//   - host-ready{pairingCode}: relay's reply once the host's hello passes validation.
//   - pair-request: a viewer completed a pairing attempt and is waiting for manual approval.
//   - error{code} / session-expired: the failure/timeout termination paths.
//   - snapshot-request: the viewer requesting a snapshot after pairing succeeds - **this
//     message is not in ./protocol.ts's RelayToClientMessage union** (that type only lists the
//     eleven types host-ready/pair-request/awaiting-approval/pair-approve/pair-reject/
//     snapshot-manifest/image-chunk/snapshot-complete/error/host-offline/session-expired;
//     SnapshotRequestMessage only appears in ClientToRelayMessage - but relay's
//     `#handleSubsequentMessage()` does forward the viewer's `{type:"snapshot-request"}` to
//     hostSocket unchanged). This file chooses not to touch ./protocol.ts's type union (that
//     is the authoritative wire protocol shared by both sides, and any change to it would
//     require re-checking both the message shape itself, which
//     relay/test/protocol-parity.test.ts doesn't cover, and relay's own use of
//     `isSnapshotRequestMessage`), and instead, when HostSession receives a raw message, it
//     **first** checks it separately with ./protocol.ts's already-exported
//     `isSnapshotRequestMessage()`, and only then falls back to `isRelayToClientMessage()`'s
//     remaining dispatch - see HostSession.#onMessage() at the end of the file.
// awaiting-approval/pair-approve/pair-reject/snapshot-manifest/image-chunk/
// snapshot-complete/host-offline are each either viewer-only (host-offline and
// awaiting-approval are only sent to the viewer), or sent by the host itself with relay never
// echoing it back (pair-approve/pair-reject are only forwarded to the viewer, never sent back
// to the host's own connection - see session-do.ts's #onPairApprove()/#onPairReject()), or a
// message type the host itself sends (snapshot-manifest/image-chunk/snapshot-complete). The
// state machine therefore needs no transitions for these types that, in theory, the host side
// never receives; #onMessage() always fail-closed ignores them (this isn't silently pretending
// they're valid - it's "this message shouldn't appear on the host connection, so take no
// action").
import {
  MAX_CHUNK_BYTES,
  MAX_MANIFEST_JSON_BYTES,
  deriveSid,
  deriveViewerToken,
  generateHostKey,
  isPreviewSnapshot,
  isRelayToClientMessage,
  isSnapshotRequestMessage,
  tryParseJson,
  type ClientToRelayMessage,
  type HostReadyMessage,
  type ImageChunkMessage,
  type PreviewErrorCode,
} from "./protocol.ts";
import type { PreviewSnapshot } from "./snapshot.ts";
import type { PreviewSource } from "./source.ts";

// ---------------------------------------------------------------------------
// The state machine - pure functions, zero I/O.
// ---------------------------------------------------------------------------

/** See "Which messages the host actually receives in this protocol" in the file header - each
 * phase here corresponds to one fixed piece of copy the UI shows (the mapping is in the task
 * spec's "state copy" section; the actual wording is left to the caller/UI layer to decide,
 * and this only tracks the fact of "which phase we're in right now").
 *
 *   connecting        -- The WebSocket has just started connecting; host-ready hasn't arrived
 *                         yet.
 *   waiting-for-scan  -- host-ready has arrived (there's a pairingCode/viewerUrl to render as
 *                         a QR code), waiting for the phone to scan and pair. Also returned to
 *                         after rejecting a pairing attempt once (pair-reject) - a reject does
 *                         not consume the viewerToken ("Credential design" in ./protocol.ts),
 *                         so the host should be able to keep waiting for the next pairing
 *                         attempt, not end the whole session.
 *   confirm-pairing   -- pair-request has arrived, waiting for the user to manually approve or
 *                         reject.
 *   transferring      -- After the user approves (pair-approve has been sent), whether or not
 *                         snapshot-request has arrived yet or chunks have started sending, this
 *                         is uniformly treated as one single user-visible phase, "paired, the
 *                         phone is reading" (to the reader, "waiting for the viewer to send its
 *                         request" and "chunks are streaming" feel the same; the fixed status
 *                         copy provides only this one line).
 *   sent              -- This snapshot-request has been fully answered (manifest + every chunk
 *                         + snapshot-complete have all been sent).
 *   send-blocked      -- snapshot-request arrived, but either the local snapshot couldn't be
 *                         read, or the snapshot exceeds the protocol's size cap - **nothing was
 *                         sent** (if it's over the limit, nothing is sent, and the reason is
 *                         shown), the session is still connected, and `errorMessage` carries
 *                         the reason.
 *   host-offline      -- Was once connected and running normally (reached at least
 *                         waiting-for-scan), and then the WebSocket closed unexpectedly with
 *                         relay never sending an error/session-expired to explain why first
 *                         (see the full criteria in applyConnectionLost() below).
 *   session-expired   -- relay sent {type:"session-expired"} (some TTL expired).
 *   relay-error       -- Received {type:"error", code} (a protocol-level error), or the
 *                         connection was interrupted before it ever successfully connected
 *                         (close/error while still in the connecting phase).
 *   ended             -- The user actively pressed "End preview."
 */
export type HostSessionPhase =
  | "connecting"
  | "waiting-for-scan"
  | "confirm-pairing"
  | "transferring"
  | "sent"
  | "send-blocked"
  | "host-offline"
  | "session-expired"
  | "relay-error"
  | "ended";

export interface HostSessionState {
  readonly phase: HostSessionPhase;
  /** Only has a value once host-ready arrives; once set, it's kept until the whole session
   * ends (after a reject, the same pairing code/QR keeps showing - it isn't cleared and
   * regenerated). */
  readonly pairingCode: string | null;
  /** The URL for the phone to scan (`${location.origin}/preview.html#t=<viewerToken>`) - same
   * as pairingCode, once set it's kept until the session ends. */
  readonly viewerUrl: string | null;
  /** Extra detail for send-blocked/host-offline/relay-error, a full sentence meant for the
   * user (not an internal debugging string like ./source.ts's PreviewSourceError.reason) - it
   * is always `null` in every other phase. */
  readonly errorMessage: string | null;
}

export const initialHostSessionState: HostSessionState = {
  phase: "connecting",
  pairingCode: null,
  viewerUrl: null,
  errorMessage: null,
};

/** host-ready arrived - record the pairing code and (computed by the caller, passed in) the
 * URL for the phone to scan, and enter waiting-for-scan. `viewerUrl` is computed by the caller
 * (it needs `location.origin`, a DOM global, which is outside the scope of this zero-I/O file's
 * responsibility); this only puts it into the state. */
export function applyHostReady(state: HostSessionState, message: HostReadyMessage, viewerUrl: string): HostSessionState {
  return { ...state, phase: "waiting-for-scan", pairingCode: message.pairingCode, viewerUrl, errorMessage: null };
}

/** pair-request arrived - only an expected transition while "waiting to be scanned" (per
 * relay's rule: once paired, the same viewerToken never gets a second viewer connecting, so in
 * theory this message should never arrive in any phase other than waiting-for-scan); in every
 * other phase, this is treated as a stale/impossible message and simply ignored, not a
 * fail-closed abort of the whole session - a single message arriving late or duplicated just
 * doesn't need handling; it does not mean the protocol was broken badly enough to end the
 * session. */
export function applyPairRequest(state: HostSessionState): HostSessionState {
  if (state.phase !== "waiting-for-scan") return state;
  return { ...state, phase: "confirm-pairing" };
}

/** The user pressed "approve" - the caller (HostSession) is responsible for actually sending
 * pair-approve; this only transitions the state. Approving only means something during the
 * confirm-pairing phase. */
export function applyApprove(state: HostSessionState): HostSessionState {
  if (state.phase !== "confirm-pairing") return state;
  return { ...state, phase: "transferring" };
}

/** The user pressed "reject" - goes back to waiting-for-scan (not some kind of terminal state);
 * pairingCode/viewerUrl are kept as-is, matching relay's decision that "a reject does not
 * consume the viewerToken, and the host can keep waiting for the next pairing attempt" (see
 * "Credential design" in the ./protocol.ts header). */
export function applyReject(state: HostSessionState): HostSessionState {
  if (state.phase !== "confirm-pairing") return state;
  return { ...state, phase: "waiting-for-scan" };
}

/** manifest + every image-chunk + snapshot-complete have all been sent. */
export function applySnapshotSent(state: HostSessionState): HostSessionState {
  return { ...state, phase: "sent", errorMessage: null };
}

/** snapshot-request arrived, but either the local snapshot couldn't be read, or the snapshot
 * exceeds the protocol's size cap - nothing gets sent, and the reason is
 * recorded for the user to see. The session itself does not end (it's still connected; in
 * theory the user could fix the content and then end the preview and open a fresh session to
 * try again - this protocol has no "retry sending within the same session" message type, see
 * ./protocol.ts; retrying means redoing the whole pairing flow). */
export function applySendBlocked(state: HostSessionState, reason: string): HostSessionState {
  return { ...state, phase: "send-blocked", errorMessage: reason };
}

export function applySessionExpired(state: HostSessionState): HostSessionState {
  return { ...state, phase: "session-expired", errorMessage: null };
}

export function applyRelayError(state: HostSessionState, code: PreviewErrorCode): HostSessionState {
  return { ...state, phase: "relay-error", errorMessage: describeErrorCode(code) };
}

/** The WebSocket closed unexpectedly (not because the user pressed "End preview," and not
 * because an error/session-expired message arrived first and closed it - those two each have
 * their own applyXxx() that already transitions the phase, so #onClose() never calls this in
 * those cases). Two scenarios:
 *   - The connection never even survived to host-ready (still in connecting) - treated as
 *     "the relay connection failed" (relay-error); this is the only branch with no relay
 *     message to go on at all, inferred purely from the fact that "the connection was never
 *     established."
 *   - It was already running normally (reached at least waiting-for-scan or later) - treated
 *     as "the phone went offline" (host-offline). An honest note: the relay protocol itself has
 *     no dedicated message to the host for a viewer disconnecting (see "Known limitation" in
 *     relay/README.md), so the host has no real way to distinguish "the viewer's phone
 *     disconnected" from "the host's own connection dropped" - this deliberately chooses the
 *     user-understandable phrase "the phone went offline" to cover this whole class of
 *     situation ("it was connected, then it dropped, and relay never explained why first"); it
 *     is not a claim that this code actually observed the other end's phone connection status. */
export function applyConnectionLost(state: HostSessionState): HostSessionState {
  if (state.phase === "ended" || state.phase === "session-expired" || state.phase === "relay-error") return state;
  if (state.phase === "connecting") {
    return { ...state, phase: "relay-error", errorMessage: "The relay connection failed. Check your network and try again." };
  }
  return { ...state, phase: "host-offline", errorMessage: null };
}

export function applyEnded(state: HostSessionState): HostSessionState {
  return { ...state, phase: "ended", errorMessage: null };
}

const ERROR_CODE_LABEL: Record<PreviewErrorCode, string> = {
  "invalid-token": "credential validation failed",
  "token-consumed": "this pairing link has already been used",
  "not-paired": "pairing hasn't finished yet",
  "host-offline": "the connection went offline",
  "session-expired": "the connection expired",
  "too-large": "the transfer exceeded the size limit",
  "protocol-violation": "a protocol error occurred",
  "rate-limited": "the transfer rate exceeded the limit",
};

function describeErrorCode(code: PreviewErrorCode): string {
  return `A relay connection error occurred (${ERROR_CODE_LABEL[code]}); the preview has stopped.`;
}

// ---------------------------------------------------------------------------
// Snapshot chunking - pure functions, zero I/O. The caller
// (HostSession.#handleSnapshotRequest()) decides when to call these.
// ---------------------------------------------------------------------------

/** Splits a span of raw bytes into contiguous pieces of at most `maxChunkBytes` each -
 * `Uint8Array.subarray()` is just a view, and doesn't copy the underlying memory, so chunking a
 * 5 MiB image doesn't allocate an extra 5 MiB. Always returns at least one (possibly empty)
 * piece: ./protocol.ts's `ImageChunkMessage` requires `total > 0`, so a 0-byte image (in theory
 * this should never happen - ImageMeta.byteLength itself requires > 0, see
 * ./protocol.ts's isPreviewImageMeta()) still needs to be expressed as "1 empty piece," not "0
 * pieces." */
export function chunkBytes(bytes: Uint8Array, maxChunkBytes: number = MAX_CHUNK_BYTES): Uint8Array[] {
  if (bytes.length === 0) return [bytes.subarray(0, 0)];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += maxChunkBytes) {
    chunks.push(bytes.subarray(offset, Math.min(offset + maxChunkBytes, bytes.length)));
  }
  return chunks;
}

/** Standard base64 (with padding, not the URL-safe variant ./protocol.ts's base64UrlEncode()
 * uses - the runtime validation for `ImageChunkMessage.dataBase64` (`isImageChunkMessage()`)
 * matches against the standard base64 character set, see ./protocol.ts's `BASE64_RE`). Builds
 * the string byte by byte and then `btoa()`s it, the same approach as ./protocol.ts's existing
 * `base64UrlEncode()`. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Turns one image's full bytes into a series of `image-chunk` messages; sending them in order
 * reconstructs the original content - `index` increments contiguously from 0, and `total` is
 * how many pieces this image has in total (matching relay's `#onImageChunk()` sequence-number
 * continuity check). */
export function buildImageChunkMessages(id: string, bytes: Uint8Array, maxChunkBytes: number = MAX_CHUNK_BYTES): ImageChunkMessage[] {
  const parts = chunkBytes(bytes, maxChunkBytes);
  const total = parts.length;
  return parts.map((part, index) => ({ type: "image-chunk", id, index, total, dataBase64: toBase64(part) }));
}

// ---------------------------------------------------------------------------
// Pre-send checks - pure functions, zero I/O: check PREVIEW_LIMITS and the
// protocol caps before sending; if it's over the limit, don't send it and show why.
// ---------------------------------------------------------------------------

export type SnapshotSizeCheckResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** `isPreviewSnapshot()` (./protocol.ts) already covers PREVIEW_LIMITS's page count/character
 * count/choice count caps (via `isPreviewStory()`/`isPreviewPage()`), the per-image size cap
 * (`isPreviewImageMeta()`'s `MAX_IMAGE_BYTES`), and the cap on the sum of all image bytes
 * (`MAX_SNAPSHOT_TOTAL_BYTES`) - this reuses it directly rather than rewriting an equivalent
 * check. The only thing that still needs a separate check is the size cap on the
 * `snapshot-manifest` message as a *whole* (not just the snapshot field), once serialized to
 * JSON (`MAX_MANIFEST_JSON_BYTES`) - that is a cap on the transport-layer message size, not a
 * cap on the snapshot data's own fields, and `isPreviewSnapshot()` doesn't, and shouldn't,
 * check it. */
export function checkSnapshotSize(snapshot: PreviewSnapshot): SnapshotSizeCheckResult {
  if (!isPreviewSnapshot(snapshot)) {
    return { ok: false, reason: "The story content exceeds the preview feature's size limits (page count, character count, choice count, or image size), so it can't be sent to the phone." };
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify({ type: "snapshot-manifest", snapshot })).length;
  if (manifestBytes > MAX_MANIFEST_JSON_BYTES) {
    return { ok: false, reason: "The story structure is too large, exceeding the limit for a single preview transfer, so it can't be sent to the phone." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HostSession - a thin WebSocket wrapper: open the connection, send hello, turn incoming
// messages into calls to the pure functions above, and actually send whatever message those
// pure functions decide to send. The UI layer only calls the methods here and subscribes to
// onStateChange.
//
// The lifecycle: lives in ../ui/controller.ts, and does not
// end when the on-screen tab switches - one HostSession instance is held by the controller
// (see `#mobileSession` in that file), counting from the first time the user switches to the
// "phone preview" tab, and staying alive until one of the following three things happens and
// really closes the connection:
//   1. The user presses "End preview" (controller.endMobilePreview() -> end() here).
//   2. The whole editor view is left (the story got deleted, a read error occurred -
//      controller.hydrate() calls end() proactively when it decides the new view isn't
//      "editor").
//   3. The tab itself is being unloaded (pagehide/beforeunload - the global listener attached
//      in ../main.ts).
// The user switching between the "story map"/"preview reading"/"phone preview" tabs **does
// not** trigger any end() call; the old rule of
// "leaving the preview tab closes the WS" no longer holds.
// ---------------------------------------------------------------------------

export interface HostSessionDeps {
  /** relay's connection address (no path, e.g. `ws://localhost:8787`) - the caller is
   * responsible for reading it from `import.meta.env.VITE_PREVIEW_RELAY_URL` and passing it in
   * (this file has zero Vite dependency, the same discipline as ./protocol.ts: the
   * protocol/session logic shouldn't know which build tool bundled it). */
  readonly relayUrl: string;
  /** Reads the local story snapshot/images - this is exactly the same LocalSource
   * ../ui/controller.ts's `createPreviewSource()` is already using; the caller passes it in
   * directly, and this file never assembles it itself. `source.load()` is only actually called
   * once a snapshot-request arrives during the session (see `#handleSnapshotRequest()`) - it's
   * always a fresh read, never cached, and always answers with whatever's currently in
   * IndexedDB at the moment the request arrives. */
  readonly source: PreviewSource;
  readonly onStateChange: (state: HostSessionState) => void;
}

/** The public HostSession interface actually used by ../ui/controller.ts - defined
 * independently as an interface (rather than using the `HostSession` class type directly), so
 * the controller's tests can inject a fake implementation (see the "switching tabs doesn't end
 * the session, only ending the preview does" test group in
 * ../ui/controller.workspace.test.ts) without needing to open a real WebSocket.
 * `HostSession implements HostSessionLike` guarantees production uses exactly the shape
 * described here. */
export interface HostSessionLike {
  getState(): HostSessionState;
  start(viewerOrigin: string): Promise<void>;
  approve(): void;
  reject(): void;
  end(): void;
}

export class HostSession implements HostSessionLike {
  #ws: WebSocket | null = null;
  #state: HostSessionState = initialHostSessionState;
  #hostKey: string | null = null;
  #pendingViewerUrl = "";
  #ended = false;
  readonly #deps: HostSessionDeps;

  constructor(deps: HostSessionDeps) {
    this.#deps = deps;
  }

  getState(): HostSessionState {
    return this.#state;
  }

  #setState(next: HostSessionState): void {
    this.#state = next;
    this.#deps.onStateChange(next);
  }

  /** Generates the credential chain, opens the WebSocket, and sends the first hello. The
   * caller guarantees this is only called once (see the host panel under ../ui/ - one
   * HostSession instance gets created per click of the "phone preview" button). `viewerOrigin`
   * is `location.origin` (a DOM global; the caller is responsible for obtaining it and passing
   * it in, for the same reason as `relayUrl`: this file has zero DOM dependency). */
  async start(viewerOrigin: string): Promise<void> {
    if (this.#ws) return;
    const hostKey = generateHostKey();
    this.#hostKey = hostKey;
    const viewerToken = await deriveViewerToken(hostKey);
    const sid = await deriveSid(viewerToken);
    this.#pendingViewerUrl = `${viewerOrigin}/preview.html#t=${viewerToken}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.#deps.relayUrl}/session?sid=${sid}`);
    } catch {
      this.#setState(applyConnectionLost(this.#state));
      return;
    }
    this.#ws = ws;
    ws.addEventListener("open", () => this.#send({ type: "hello", role: "host", hostKey }));
    ws.addEventListener("message", (event) => this.#onMessage(event));
    ws.addEventListener("close", () => this.#onClose());
    ws.addEventListener("error", () => this.#onClose());
  }

  #send(message: ClientToRelayMessage): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    try {
      this.#ws.send(JSON.stringify(message));
    } catch {
      // The other end has already disconnected - nothing more to do; the close event will
      // take over handling the subsequent state transition.
    }
  }

  #onMessage(event: MessageEvent): void {
    if (this.#ended || typeof event.data !== "string") return;
    const parsed = tryParseJson(event.data);
    if (!parsed.ok) return; // fail-closed: bad JSON is ignored outright, no guessing intent

    // See the file header - snapshot-request is not in ./protocol.ts's RelayToClientMessage
    // union, so it's checked separately here.
    if (isSnapshotRequestMessage(parsed.value)) {
      void this.#handleSnapshotRequest();
      return;
    }
    if (!isRelayToClientMessage(parsed.value)) return; // fail-closed: invalid shape, ignore
    const message = parsed.value;

    switch (message.type) {
      case "host-ready":
        this.#setState(applyHostReady(this.#state, message, this.#pendingViewerUrl));
        return;
      case "pair-request":
        this.#setState(applyPairRequest(this.#state));
        return;
      case "session-expired":
        this.#ended = true;
        this.#setState(applySessionExpired(this.#state));
        return;
      case "error":
        this.#ended = true;
        this.#setState(applyRelayError(this.#state, message.code));
        return;
      default:
        // awaiting-approval/pair-approve/pair-reject/snapshot-manifest/image-chunk/
        // snapshot-complete/host-offline - see the file header; in theory the host connection
        // never receives these, so fail-closed and ignore.
        return;
    }
  }

  #onClose(): void {
    if (this.#ended) return;
    this.#setState(applyConnectionLost(this.#state));
  }

  /** The user pressed "approve" - only valid during confirm-pairing; calling it in any other
   * phase is a no-op (the UI layer only ever shows this button during that phase to begin with,
   * this is the second line of defense). */
  approve(): void {
    if (this.#state.phase !== "confirm-pairing") return;
    this.#send({ type: "pair-approve" });
    this.#setState(applyApprove(this.#state));
  }

  reject(): void {
    if (this.#state.phase !== "confirm-pairing") return;
    this.#send({ type: "pair-reject" });
    this.#setState(applyReject(this.#state));
  }

  async #handleSnapshotRequest(): Promise<void> {
    // Only once pairing has really succeeded and the user has already pressed approve is this
    // "a snapshot-request worth answering" phase - in theory relay has also already blocked
    // the not-paired case (see session-do.ts); this is a second fail-closed line of defense
    // that never assumes the other end is definitely following the protocol.
    if (this.#state.phase !== "transferring") return;

    const result = await this.#deps.source.load();
    if (!result.ok) {
      this.#setState(applySendBlocked(this.#state, describeSourceLoadFailure(result.error.type)));
      return;
    }
    const sizeCheck = checkSnapshotSize(result.snapshot);
    if (!sizeCheck.ok) {
      this.#setState(applySendBlocked(this.#state, sizeCheck.reason));
      return;
    }

    // Every image's bytes are fully read and its length checked against the byteLength the
    // manifest is about to claim, before anything starts being sent - a read failing partway
    // through, leaving "manifest already sent, but some image only half sent," is harder to
    // handle than not sending anything at all (the viewer would have already allocated a
    // buffer per the manifest, but would then wait forever for the final chunk).
    const imageBytes = new Map<string, Uint8Array>();
    for (const meta of result.snapshot.images) {
      const bytes = await this.#deps.source.image(meta.id);
      if (!bytes || bytes.length !== meta.byteLength) {
        this.#setState(applySendBlocked(this.#state, `The image content couldn't be read, or its size doesn't match, so it can't be sent to the phone.`));
        return;
      }
      imageBytes.set(meta.id, bytes);
    }

    this.#send({ type: "snapshot-manifest", snapshot: result.snapshot });
    for (const meta of result.snapshot.images) {
      const bytes = imageBytes.get(meta.id)!;
      for (const chunk of buildImageChunkMessages(meta.id, bytes)) {
        this.#send(chunk);
      }
    }
    this.#send({ type: "snapshot-complete" });
    this.#setState(applySnapshotSent(this.#state));
  }

  /** Called by any of the three triggers (see the note above the class:
   * the user pressed "End preview," the editor view was left, or the tab was unloaded) - closes
   * the underlying connection; the caller (../ui/controller.ts) should afterward discard this
   * HostSession instance entirely (the next time the "phone preview" tab is entered, a brand
   * new one gets created, not this one restarted). Guaranteed safe to call more than once. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#setState(applyEnded(this.#state));
    if (this.#ws) {
      try {
        this.#ws.close(1000, "ended");
      } catch {
        // Already closing - nothing more to do.
      }
    }
  }
}

function describeSourceLoadFailure(type: string): string {
  switch (type) {
    case "no-story":
      return "There's no story to preview right now, so nothing can be sent to the phone.";
    case "invalid-story":
      return "The current story content can't be previewed yet (its structure or content has an issue), so it can't be sent to the phone.";
    default:
      return "Something went wrong while reading the story content, so it can't be sent to the phone. Please try again in a moment.";
  }
}
