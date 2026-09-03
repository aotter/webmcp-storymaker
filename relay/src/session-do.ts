// SessionDO: the Durable Object for one session (the full lifecycle of one pairing plus one
// snapshot transfer). The core constraint -- **zero storage**: this file must
// never contain any `ctx.storage`/`state.storage` API (statically checked by
// ../scripts/check-no-storage.mjs, which scans relay/src for a set of persistence-related terms
// and expects zero hits outside this header explanation itself -- this explanation is itself
// watched by that script; when the header grows or shrinks, the script's line-number window must
// be adjusted to match, and the script's own sanity check fails loudly if you forget). All state
// (host/viewer WebSockets, the pairing code, TTL timers, per-connection rate-limit counters,
// image-chunk sequence progress) lives only in this class instance's private fields.
//
// What happens after the DO is evicted (described precisely here, not the loose
// analogy of "equivalent to the TTL expiring"): this DO instance can be evicted by the runtime at
// any time once it has no connections or timers left; after eviction, the same sid connecting
// again gets a brand-new instance that remembers nothing about the previous state. This was a hole
// in the original design -- if the credential were "host and viewer share the same token", anyone
// who had ever obtained that token could impersonate the host on the new instance after an
// eviction. The fix was to switch the credential to a hash chain (see the full derivation in the
// "credential design" section of ../../src/preview/protocol.ts): the viewer only ever gets a
// one-way hash of hostKey (viewerToken), and can't derive hostKey back from it, so no matter how
// many times the DO is evicted and replaced with a fresh instance, **without hostKey it is
// impossible to pass host-hello verification** -- that verification is a pure function (whether
// sid equals hostKey hashed twice), independent of any in-memory state, so a new instance and the
// original instance always agree on the verification result. After an eviction, the only thing
// anyone who has the viewerToken (i.e. anyone who has seen the QR code or that URL) can do is
// reconnect as a viewer, send a hello, and wait for approval -- but with no live host tab, the
// relay never receives a pair-approve, and the viewer is stuck at awaiting-approval forever,
// getting no story content. In other words: a DO eviction never lets anyone "accidentally become
// the host" -- it only resets an already-live session to the state of waiting for a new viewer to
// reconnect, which feels the same as a TTL expiring or the host disconnecting on purpose (both are
// "this session is interrupted for now; the user either waits for the host to reconnect or scans
// the QR code again") -- it's just no longer glossed over with the imprecise phrase "equivalent to
// a TTL".
//
// Why setTimeout instead of forcing it through an alarm: `ctx.storage.setAlarm()` is itself part
// of the `ctx.storage` API -- using an alarm for the TTL would directly violate the zero-storage
// line, not some gray area of "using alarm while avoiding the rest of storage". TTLs therefore use
// plain `setTimeout` (see the #armXxxTtl family of methods).
//
// Why the standard WebSocket API instead of the Hibernation API: this DO deliberately uses the
// "standard WebSocket API" (`server.accept()` + addEventListener), not the "Hibernation WebSocket
// API" (`ctx.acceptWebSocket()`) -- the official docs state plainly that during hibernation
// "in-memory state is reset"; the constructor reruns on wake, and any field that wasn't saved into
// storage/an attachment simply vanishes. This DO's core state lives entirely in memory -- using the
// Hibernation API would instead make that state disappear out of nowhere during an unpredictable
// hibernation cycle, which is more dangerous than simply not supporting hibernation at all. The
// cost of the standard API is that this DO instance keeps being billed for the whole connection and
// can't save cost by hibernating -- acceptable, since this is a low-frequency, human-triggered
// preview feature capped at 60 minutes per session, not an always-on service.
//
// Error-code dispatch rules by role semantics (used in multiple places in this file, spelled out
// here once):
//   - A connection that hasn't passed hello yet (and therefore hasn't been assigned a role) does
//     something wrong (bad credential, a second host, a second viewer, no hello sent in time, over
//     its own rate limit for this connection...) -> only **this connection** is closed; no already
//     established host/viewer connection is affected (see #rejectNewConnection).
//   - An already-established host connection does something wrong (protocol violation, over a
//     size cap, over its own rate limit for this connection) -> the whole session is judged over:
//     the host receives whatever code actually happened, and the viewer (if connected) always
//     receives host-offline -- from the viewer's perspective, "the host said something
//     unintelligible" and "the host disconnected" have the same practical outcome (nothing
//     follows), so there's no need to invent a separate viewer-legible code for every kind of host
//     fault (see #endByHostFault).
//   - An already-established viewer connection does something wrong (including going over its own
//     rate limit for this connection) -> only that viewer connection is closed, the host is
//     unaffected and keeps waiting (see #rejectViewerOnly). This matches the existing behavior of
//     "a viewer disconnecting doesn't notify the host" -- the protocol has no message type to tell
//     the host "the viewer went offline".
//
// Where rate limiting is scoped (per connection, not "one counter shared by the whole
// session") -- under an earlier design, anyone who had the sid
// (sid itself isn't a credential, but it also isn't fully random and unpredictable, see the "DO
// routing" section of the protocol file) could open one connection, spam it with garbage, and trip
// the shared counter's limit, dragging down a legitimate session that was mid-transfer along with
// it. After switching to per-connection counting: a connection that "hasn't passed hello yet" only
// ever gets one shot anyway (see the "one shot" section below), so it doesn't need separate
// counting; connections that are already host/viewer each have their own counter, and going over it
// is handled by the role-dispatch rules above (host over limit -> whole session ends; viewer over
// limit -> only that viewer is closed).
//
// The "one shot" rule: a connection that hasn't passed hello yet
// is only allowed to send **one** message, and it must be a valid hello (correct shape, hash-chain
// verification passes) -- otherwise the connection is closed with the corresponding error code; it
// doesn't get a second chance to retry with different content (retrying means opening a new
// connection). At the same time, a connection that opened but sent nothing at all within 10 seconds
// is also proactively closed (PRE_AUTH_TIMEOUT_MS) -- to stop someone from opening a pile of
// connections that just sit there sending nothing.

import { DurableObject } from "cloudflare:workers";
import type { PreviewErrorCode } from "../../src/preview/protocol.ts";
import { sidFromHostKey, sidFromViewerToken } from "./crypto.ts";
import {
  ERROR_CLOSE_CODE,
  IDLE_TTL_MS,
  PAIRING_TTL_MS,
  ABSOLUTE_TTL_MS,
  PRE_AUTH_TIMEOUT_MS,
  RATE_LIMIT_MAX_MESSAGES,
  RATE_LIMIT_WINDOW_MS,
  MAX_MANIFEST_JSON_BYTES,
} from "./protocol-limits.ts";
import {
  estimateBase64DecodedLength,
  exceedsChunkSizeCap,
  isHostHelloShape,
  isImageChunkShape,
  isSnapshotManifestShape,
  isViewerHelloShape,
  tryParseJson,
  type ImageChunkShape,
} from "./validate.ts";

interface ChunkProgress {
  nextIndex: number;
  total: number;
  bytesSoFar: number;
}

/** Per-connection state -- the rate-limit counter and the "one shot" flag, see the file header.
 * Stored in a WeakMap<WebSocket, ConnectionState>, not a class field: each connection gets its own
 * entry, and this state naturally disappears when the connection itself is garbage collected, with
 * no manual cleanup needed. */
interface ConnectionState {
  preAuthShotUsed: boolean;
  preAuthTimer: ReturnType<typeof setTimeout> | null;
  rateCount: number;
  rateWindowStart: number;
}

// Env is the global environment type from worker-configuration.d.ts (generated by `pnpm types`
// from wrangler.jsonc's bindings/vars, see the comment in ../tsconfig.json) -- we don't hand-write
// a separate interface here, since a hand-written version would drift from wrangler.jsonc's actual
// binding configuration.
//
// extends DurableObject<Env> (not implements DurableObject) -- only `extends` gives access to the
// base class's `this.ctx`/`this.env`; `implements` doesn't establish a real inheritance
// relationship, so those two fields wouldn't exist. `this.env` is needed here to read the three
// test-overridable *_TTL_MS vars (see readTtlMs() below).

export class SessionDO extends DurableObject<Env> {
  #hostSocket: WebSocket | null = null;
  #viewerSocket: WebSocket | null = null;
  #pairingCode: string | null = null;
  #paired = false;
  #tokenConsumed = false;
  #ended = false;

  #connections = new WeakMap<WebSocket, ConnectionState>();

  #pairingTtlTimer: ReturnType<typeof setTimeout> | null = null;
  #idleTtlTimer: ReturnType<typeof setTimeout> | null = null;
  #absoluteTtlTimer: ReturnType<typeof setTimeout> | null = null;

  /** The most recent snapshot-manifest's claimed image id -> claimed byte count. null means no
   * manifest has been received yet in this pairing cycle, so no image-chunk is valid (there's
   * nothing to check against yet). */
  #expectedImageBytes: Map<string, number> | null = null;
  /** For each image id, which chunk index it's received up to, its claimed total, and the
   * cumulative byte count so far -- used to verify "sequence numbers are contiguous" and "hasn't
   * exceeded the size the manifest claimed". */
  #chunkProgress: Map<string, ChunkProgress> = new Map();

  // Deliberately not overriding the constructor -- there's nothing to persist, so there's no schema
  // to initialize, and no blockConcurrencyWhile() is needed. State only starts existing once the
  // first fetch() (WebSocket upgrade) arrives; the base class's constructor has already wired up
  // this.ctx/this.env for us.

  async fetch(request: Request): Promise<Response> {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    // sid is exactly the URL query string on the same request the Worker forwarded when routing
    // this connection to this DO instance -- there's no separate channel to pass it through (and
    // there couldn't be, see the "DO routing" section of the protocol file: a WebSocket can't be
    // handed off via RPC). A missing sid (shouldn't happen in theory -- the Worker side has already
    // filtered once) is always treated as an empty string; no hash-chain verification can ever
    // equal an empty string, so this fails closed naturally.
    const sid = new URL(request.url).searchParams.get("sid") ?? "";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.#attach(server, sid);
    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  #attach(ws: WebSocket, sid: string): void {
    const state: ConnectionState = { preAuthShotUsed: false, preAuthTimer: null, rateCount: 0, rateWindowStart: Date.now() };
    state.preAuthTimer = setTimeout(() => {
      if (this.#isPromoted(ws) || state.preAuthShotUsed) return;
      state.preAuthShotUsed = true;
      this.#closeRaw(ws, "protocol-violation");
    }, readTtlMs(this.env.PRE_AUTH_TIMEOUT_MS, PRE_AUTH_TIMEOUT_MS));
    this.#connections.set(ws, state);

    ws.addEventListener("message", (event: MessageEvent) => {
      void this.#onMessage(ws, event, sid, state);
    });
    ws.addEventListener("close", () => {
      this.#clearPreAuthTimer(state);
      this.#handleSocketClose(ws);
    });
    ws.addEventListener("error", () => {
      this.#clearPreAuthTimer(state);
      this.#handleSocketClose(ws);
    });
  }

  #isPromoted(ws: WebSocket): boolean {
    return ws === this.#hostSocket || ws === this.#viewerSocket;
  }

  #clearPreAuthTimer(state: ConnectionState): void {
    if (state.preAuthTimer !== null) {
      clearTimeout(state.preAuthTimer);
      state.preAuthTimer = null;
    }
  }

  async #onMessage(ws: WebSocket, event: MessageEvent, sid: string, state: ConnectionState): Promise<void> {
    if (this.#ended) {
      this.#closeRaw(ws, "session-expired");
      return;
    }

    if (!this.#isPromoted(ws)) {
      // "One shot" rule (see the header): this connection hasn't passed hello yet, so only one
      // message is processed.
      if (state.preAuthShotUsed) return; // Already processed / already closing -- ignore any further messages sent
      state.preAuthShotUsed = true;
      this.#clearPreAuthTimer(state);

      if (typeof event.data !== "string") {
        // This protocol deliberately only uses base64-in-JSON (see "choice of binary transport" in
        // the protocol file) -- it never expects a binary frame.
        this.#rejectNewConnection(ws, "protocol-violation");
        return;
      }
      if (byteLengthUtf8(event.data) > MAX_MANIFEST_JSON_BYTES) {
        this.#rejectNewConnection(ws, "too-large");
        return;
      }
      await this.#handleFirstMessage(ws, event.data, sid);
      return;
    }

    // Already host or viewer: do the cheap shape/size checks first, then the per-connection rate
    // limit, and finally dispatch as usual.
    const isHost = ws === this.#hostSocket;
    if (typeof event.data !== "string") {
      this.#violate(isHost, "protocol-violation");
      return;
    }
    if (byteLengthUtf8(event.data) > MAX_MANIFEST_JSON_BYTES) {
      this.#violate(isHost, "too-large");
      return;
    }
    // The host's image-chunk messages don't count toward the message rate: a single 5 MiB image
    // split into 32 KiB pieces is already 160 messages, and sending a few images together is
    // guaranteed to exceed 200 messages per 10 seconds -- this cap exists to stop "flooding with
    // garbage messages", and chunking is already pinned down by three separate layers (the byte
    // count the manifest declared, per-image/total size caps, and sequence contiguity, see
    // #handleImageChunk); adding a "message count" layer on top would only block normal image
    // transfers (verified on the live production site on 2026-09-03: transfer rate exceeding the
    // cap aborted the preview). This only does a cheap literal peek to decide whether it looks like
    // a chunk, not a full parse -- a piece of garbage that's mistakenly recognized as a chunk still
    // hits protocol-violation at dispatch time, which for the host ends the whole session outright,
    // stricter than rate limiting, so this doesn't let anything slip through.
    const exemptFromRateLimit = isHost && looksLikeImageChunk(event.data);
    if (!exemptFromRateLimit && !this.#checkRateLimit(state)) {
      this.#violate(isHost, "rate-limited");
      return;
    }
    this.#handleSubsequentMessage(ws, event.data);
  }

  #handleSocketClose(ws: WebSocket): void {
    if (ws === this.#hostSocket) {
      this.#endByHostDisconnect();
      return;
    }
    if (ws === this.#viewerSocket) {
      this.#viewerSocket = null;
      return;
    }
    // The close event for a connection that never passed hello and was already rejected/closed --
    // ignore it.
  }

  // -------------------------------------------------------------------------
  // The first message: must be a hello, and it decides this connection's role. Hash-chain
  // verification is asynchronous (crypto.subtle.digest), see ./crypto.ts.
  // -------------------------------------------------------------------------

  async #handleFirstMessage(ws: WebSocket, raw: string, sid: string): Promise<void> {
    const parsed = tryParseJson(raw);
    if (!parsed.ok || !isPlainObjectWithHelloType(parsed.value)) {
      this.#rejectNewConnection(ws, "protocol-violation");
      return;
    }
    const value = parsed.value;

    if (isHostHelloShape(value)) {
      await this.#handleHostHello(ws, value.hostKey, sid);
      return;
    }
    if (isViewerHelloShape(value)) {
      await this.#handleViewerHello(ws, value.token, sid);
      return;
    }
    // type is "hello", but the role/its matching field has the wrong shape: role itself is valid
    // (host/viewer) but hostKey/token has the wrong shape -> invalid-token; role isn't in
    // {host,viewer} at all -> protocol-violation.
    const role = (value as { role?: unknown }).role;
    if (role === "host" || role === "viewer") {
      this.#rejectNewConnection(ws, "invalid-token");
    } else {
      this.#rejectNewConnection(ws, "protocol-violation");
    }
  }

  async #handleHostHello(ws: WebSocket, hostKey: string, sid: string): Promise<void> {
    // Hash-chain verification happens before any synchronous state check/write -- the group of
    // synchronous operations "check whether a host already exists, and if not, claim the slot"
    // happens after the await, with no other await in between, to avoid two host-hellos arriving
    // almost simultaneously both reading "no host yet" during their respective awaits and both
    // getting through (an async function is atomic within a stretch that has no await, so it can't
    // be interleaved by another message event).
    const computedSid = await sidFromHostKey(hostKey);
    if (computedSid !== sid) {
      this.#rejectNewConnection(ws, "invalid-token");
      return;
    }
    if (this.#hostSocket) {
      // A second host -- reject this new connection; the existing host/viewer pairing is
      // unaffected.
      this.#rejectNewConnection(ws, "protocol-violation");
      return;
    }
    this.#hostSocket = ws;
    this.#pairingCode = generatePairingCode();
    this.#armPairingTtl();
    this.#armAbsoluteTtl();
    this.#send(ws, { type: "host-ready", pairingCode: this.#pairingCode });
  }

  async #handleViewerHello(ws: WebSocket, token: string, sid: string): Promise<void> {
    const computedSid = await sidFromViewerToken(token);
    if (computedSid !== sid) {
      this.#rejectNewConnection(ws, "invalid-token");
      return;
    }
    if (!this.#hostSocket) {
      // No host has ever connected yet (or the DO was just evicted and the host hasn't reconnected)
      // -- from the viewer's perspective this feels the same as "the host is already offline".
      this.#rejectNewConnection(ws, "host-offline");
      return;
    }
    if (this.#tokenConsumed) {
      this.#rejectNewConnection(ws, "token-consumed");
      return;
    }
    if (this.#viewerSocket) {
      // A viewer is already waiting/pairing -- the same (not-yet-consumed) viewerToken doesn't
      // support a second simultaneous viewer connection.
      this.#rejectNewConnection(ws, "protocol-violation");
      return;
    }
    this.#viewerSocket = ws;
    this.#send(this.#hostSocket, { type: "pair-request" });
    this.#send(ws, { type: "awaiting-approval", pairingCode: this.#pairingCode });
  }

  // -------------------------------------------------------------------------
  // Messages after the first one: dispatched by current role (host/viewer) and current state.
  // -------------------------------------------------------------------------

  #handleSubsequentMessage(ws: WebSocket, raw: string): void {
    const isHost = ws === this.#hostSocket;
    const isViewer = ws === this.#viewerSocket;
    if (!isHost && !isViewer) {
      // Shouldn't happen in theory (this connection never successfully completed hello, so it
      // shouldn't still be alive); fail closed by closing it outright.
      this.#closeRaw(ws, "protocol-violation");
      return;
    }

    if (this.#paired) this.#armIdleTtl(); // Once paired, any message re-arms the idle TTL.

    const parsed = tryParseJson(raw);
    if (!parsed.ok || !isPlainObjectWithStringType(parsed.value)) {
      this.#violate(isHost, "protocol-violation");
      return;
    }
    const msg = parsed.value;

    switch (msg.type) {
      case "pair-approve":
        if (!isHost) return this.#violate(isHost, "protocol-violation");
        if (!this.#viewerSocket || this.#paired) return this.#violate(true, "protocol-violation");
        return this.#onPairApprove();

      case "pair-reject":
        if (!isHost) return this.#violate(isHost, "protocol-violation");
        if (!this.#viewerSocket || this.#paired) return this.#violate(true, "protocol-violation");
        return this.#onPairReject();

      case "snapshot-request":
        if (isHost) return this.#violate(true, "protocol-violation");
        if (!this.#paired) return this.#rejectViewerOnly("not-paired");
        if (this.#hostSocket) this.#send(this.#hostSocket, msg);
        return;

      case "snapshot-manifest":
        if (!isHost) return this.#violate(isHost, "protocol-violation");
        if (!this.#paired) return this.#violate(true, "protocol-violation");
        return this.#onSnapshotManifest(msg);

      case "image-chunk":
        if (!isHost) return this.#violate(isHost, "protocol-violation");
        if (!this.#paired) return this.#violate(true, "protocol-violation");
        return this.#onImageChunk(msg);

      case "snapshot-complete":
        if (!isHost) return this.#violate(isHost, "protocol-violation");
        if (!this.#paired) return this.#violate(true, "protocol-violation");
        this.#expectedImageBytes = null;
        this.#chunkProgress.clear();
        if (this.#viewerSocket) this.#send(this.#viewerSocket, msg);
        return;

      default:
        this.#violate(isHost, "protocol-violation");
    }
  }

  #onPairApprove(): void {
    const viewer = this.#viewerSocket;
    if (!viewer) return; // The caller has already checked this -- this is just a safety net.
    this.#tokenConsumed = true;
    this.#paired = true;
    this.#clearTimer(this.#pairingTtlTimer);
    this.#pairingTtlTimer = null;
    this.#armIdleTtl();
    this.#send(viewer, { type: "pair-approve" });
  }

  #onPairReject(): void {
    const viewer = this.#viewerSocket;
    if (!viewer) return;
    this.#viewerSocket = null;
    this.#send(viewer, { type: "pair-reject" });
    this.#tryClose(viewer, 1000, "pair-reject");
    // The host stays connected and the pairing TTL isn't reset: a reject doesn't consume
    // the viewerToken; the host can keep waiting for the next pairing attempt until the original
    // 5-minute pairing window runs out.
  }

  #onSnapshotManifest(msg: unknown): void {
    if (!isSnapshotManifestShape(msg)) {
      this.#violate(true, "protocol-violation");
      return;
    }
    this.#expectedImageBytes = new Map(msg.snapshot.images.map((img) => [img.id, img.byteLength]));
    this.#chunkProgress.clear();
    if (this.#viewerSocket) this.#send(this.#viewerSocket, msg);
  }

  #onImageChunk(msg: unknown): void {
    if (!isImageChunkShape(msg)) {
      this.#violate(true, "protocol-violation");
      return;
    }
    if (exceedsChunkSizeCap(msg.dataBase64)) {
      this.#violate(true, "too-large");
      return;
    }
    if (!this.#expectedImageBytes || !this.#expectedImageBytes.has(msg.id)) {
      // This image was never present in the most recent manifest -- we don't know it and don't
      // trust it.
      this.#violate(true, "protocol-violation");
      return;
    }
    const declaredBytes = this.#expectedImageBytes.get(msg.id)!;
    const progress = this.#chunkProgress.get(msg.id) ?? { nextIndex: 0, total: msg.total, bytesSoFar: 0 };
    if (msg.total !== progress.total) {
      this.#violate(true, "protocol-violation"); // The same image claimed a different total across messages
      return;
    }
    if (msg.index !== progress.nextIndex) {
      this.#violate(true, "protocol-violation"); // Sequence numbers aren't contiguous
      return;
    }
    const bytesSoFar = progress.bytesSoFar + estimateBase64DecodedLength(msg.dataBase64);
    if (bytesSoFar > declaredBytes) {
      this.#violate(true, "too-large"); // The manifest declared a smaller size, but the actual bytes pushed exceeded it
      return;
    }
    this.#chunkProgress.set(msg.id, { nextIndex: progress.nextIndex + 1, total: progress.total, bytesSoFar });
    if (this.#viewerSocket) this.#send(this.#viewerSocket, msg as ImageChunkShape);
  }

  // -------------------------------------------------------------------------
  // Termination paths -- see "error-code dispatch rules" in the file header.
  // -------------------------------------------------------------------------

  #violate(isHost: boolean, code: PreviewErrorCode): void {
    if (isHost) {
      this.#endByHostFault(code);
    } else {
      this.#rejectViewerOnly(code);
    }
  }

  /** A new connection that hasn't been assigned a role yet does something wrong -- only this new
   * connection is closed, no existing state is touched. */
  #rejectNewConnection(ws: WebSocket, code: PreviewErrorCode): void {
    this.#closeRaw(ws, code);
  }

  /** A paired or pairing-pending viewer does something wrong -- only the viewer is closed, the host
   * is unaffected. */
  #rejectViewerOnly(code: PreviewErrorCode): void {
    const viewer = this.#viewerSocket;
    if (!viewer) return;
    this.#viewerSocket = null;
    this.#closeRaw(viewer, code);
  }

  /** The host does something wrong -- the whole session ends: the host receives whatever code
   * actually happened, the viewer (if connected) receives host-offline. */
  #endByHostFault(hostCode: PreviewErrorCode): void {
    if (this.#ended) return;
    const host = this.#hostSocket;
    const viewer = this.#viewerSocket;
    this.#terminate();
    if (host) this.#closeRaw(host, hostCode);
    if (viewer) this.#closeRaw(viewer, "host-offline");
  }

  /** The host's own WebSocket triggered a close/error event -- the host side is already closing, so
   * there's no need (and no way) to send it another message or call close() on it. */
  #endByHostDisconnect(): void {
    if (this.#ended) return;
    const viewer = this.#viewerSocket;
    this.#terminate();
    if (viewer) this.#closeRaw(viewer, "host-offline");
  }

  #endBySessionExpired(): void {
    if (this.#ended) return;
    const host = this.#hostSocket;
    const viewer = this.#viewerSocket;
    this.#terminate();
    if (host) this.#closeRaw(host, "session-expired");
    if (viewer) this.#closeRaw(viewer, "session-expired");
  }

  #terminate(): void {
    this.#ended = true;
    this.#clearAllTimers();
    this.#hostSocket = null;
    this.#viewerSocket = null;
  }

  #closeRaw(ws: WebSocket, code: PreviewErrorCode): void {
    this.#send(ws, { type: "error", code });
    this.#tryClose(ws, ERROR_CLOSE_CODE[code], code);
  }

  #tryClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // The connection may already be closing -- there's nothing more to do.
    }
  }

  #send(ws: WebSocket, message: unknown): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The other side has already disconnected -- there's nothing more to do; the respective close
      // event handles what follows.
    }
  }

  // -------------------------------------------------------------------------
  // TTL timers -- all plain in-memory setTimeout, kept out of any persistence layer, per the file header.
  // -------------------------------------------------------------------------

  #armPairingTtl(): void {
    this.#clearTimer(this.#pairingTtlTimer);
    this.#pairingTtlTimer = setTimeout(() => this.#endBySessionExpired(), readTtlMs(this.env.PAIRING_TTL_MS, PAIRING_TTL_MS));
  }

  #armIdleTtl(): void {
    this.#clearTimer(this.#idleTtlTimer);
    this.#idleTtlTimer = setTimeout(() => this.#endBySessionExpired(), readTtlMs(this.env.IDLE_TTL_MS, IDLE_TTL_MS));
  }

  #armAbsoluteTtl(): void {
    // Set exactly once, at host hello -- never extended or reset by any activity.
    this.#absoluteTtlTimer = setTimeout(() => this.#endBySessionExpired(), readTtlMs(this.env.ABSOLUTE_TTL_MS, ABSOLUTE_TTL_MS));
  }

  #clearAllTimers(): void {
    this.#clearTimer(this.#pairingTtlTimer);
    this.#pairingTtlTimer = null;
    this.#clearTimer(this.#idleTtlTimer);
    this.#idleTtlTimer = null;
    this.#clearTimer(this.#absoluteTtlTimer);
    this.#absoluteTtlTimer = null;
  }

  #clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer !== null) clearTimeout(timer);
  }

  // -------------------------------------------------------------------------
  // Rate limit -- per-connection fixed-window counter (see "where rate limiting
  // is scoped" in the header).
  // -------------------------------------------------------------------------

  #checkRateLimit(state: ConnectionState): boolean {
    const now = Date.now();
    if (now - state.rateWindowStart >= RATE_LIMIT_WINDOW_MS) {
      state.rateWindowStart = now;
      state.rateCount = 0;
    }
    state.rateCount += 1;
    return state.rateCount <= RATE_LIMIT_MAX_MESSAGES;
  }
}

// ---------------------------------------------------------------------------
// Pure-function helpers -- touch no DO state, pulled out so they can be tested on their own.

/** A cheap literal peek: does this JSON text look like an image-chunk (not a full parse -- this is
 * only used to decide whether it counts toward the message rate, see the note in #onMessage; the
 * real shape validation happens at dispatch time). */
export function looksLikeImageChunk(raw: string): boolean {
  return /"type"\s*:\s*"image-chunk"/.test(raw);
}
// ---------------------------------------------------------------------------

function isPlainObjectWithHelloType(x: unknown): x is { type: "hello" } {
  return typeof x === "object" && x !== null && !Array.isArray(x) && (x as Record<string, unknown>).type === "hello";
}

function isPlainObjectWithStringType(x: unknown): x is { type: string } {
  return typeof x === "object" && x !== null && !Array.isArray(x) && typeof (x as Record<string, unknown>).type === "string";
}

/** UTF-8 byte length (a JS string's .length is a count of UTF-16 code units, not bytes -- the two
 * differ a lot when the story content contains Chinese). Measured with TextEncoder, not an
 * approximation -- the size cap is a hard security boundary, and shouldn't use a measurement that
 * could underestimate it. */
function byteLengthUtf8(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A one-time pairing code: 4 digits, for human eyeball verification. The real security boundary is
 * the hash-chain credential; the pairing code is only there to give the user a visual confirmation
 * that "are these two devices connected to the same pairing request" -- even an imperfectly uniform
 * distribution wouldn't be a security problem here, but crypto.getRandomValues() is still used
 * instead of Math.random() to stay consistent with the project's general rule that "any random
 * number involved in identification/verification always goes through Web Crypto". */
function generatePairingCode(): string {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 10_000;
  return value.toString().padStart(4, "0");
}

/** Reads a TTL override value (wrangler.jsonc vars are always strings) -- if it's missing, not a
 * number, or <= 0, always falls back to the official constant in protocol-limits.ts, so a
 * misconfigured var can never turn a TTL into 0 (= expires instantly) or negative (= never expires,
 * even more dangerous). The only reason this mechanism exists is so ../test/session-do.test.ts can
 * use extremely short test TTLs to verify expiry behavior without actually waiting 5/10/60 minutes
 * -- the production wrangler.jsonc sets all three vars to the same values as the constants. */
function readTtlMs(envValue: string | undefined, fallback: number): number {
  const parsed = envValue === undefined ? NaN : Number(envValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
