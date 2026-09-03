// The pure-function part of ./hostSession.ts - the state-machine transition
// sequence + chunking. Zero I/O, zero WebSocket, feeding sequences of messages/bytes directly
// and comparing the results. The HostSession class itself (the thin wrapper that actually touches
// WebSocket) is not tested here - its logic is entirely delegated to these already-tested pure
// functions below, plus glue too thin to be worth testing ("turn incoming messages into calls,
// send whatever needs to be sent") - the same discipline as the ../ui/dom.ts header.
import { describe, expect, it } from "vitest";
import {
  applyApprove,
  applyConnectionLost,
  applyEnded,
  applyHostReady,
  applyPairRequest,
  applyReject,
  applyRelayError,
  applySendBlocked,
  applySessionExpired,
  applySnapshotSent,
  buildImageChunkMessages,
  checkSnapshotSize,
  chunkBytes,
  initialHostSessionState,
  type HostSessionState,
} from "./hostSession.ts";
import { MAX_CHUNK_BYTES, isImageChunkMessage } from "./protocol.ts";
import type { PreviewSnapshot } from "./snapshot.ts";

const HOST_READY = { type: "host-ready" as const, pairingCode: "1234" };
const VIEWER_URL = "https://example.test/preview.html#t=abc";

describe("hostSession.ts - the state machine (pure functions)", () => {
  it("the full happy-path sequence: connecting -> host-ready -> pair-request -> approve -> transferring -> sent", () => {
    let state = initialHostSessionState;
    expect(state.phase).toBe("connecting");

    state = applyHostReady(state, HOST_READY, VIEWER_URL);
    expect(state).toEqual({ phase: "waiting-for-scan", pairingCode: "1234", viewerUrl: VIEWER_URL, errorMessage: null });

    state = applyPairRequest(state);
    expect(state.phase).toBe("confirm-pairing");
    // pairingCode/viewerUrl are kept throughout, and are never cleared by a phase transition -
    // the QR/pairing code needs to keep showing until the session really ends.
    expect(state.pairingCode).toBe("1234");
    expect(state.viewerUrl).toBe(VIEWER_URL);

    state = applyApprove(state);
    expect(state.phase).toBe("transferring");

    state = applySnapshotSent(state);
    expect(state).toEqual({ phase: "sent", pairingCode: "1234", viewerUrl: VIEWER_URL, errorMessage: null });
  });

  it("the reject path: confirm-pairing -> reject -> back to waiting-for-scan (the pairing code/QR isn't consumed; see \"Credential design\" in the ./protocol.ts header)", () => {
    let state = initialHostSessionState;
    state = applyHostReady(state, HOST_READY, VIEWER_URL);
    state = applyPairRequest(state);

    state = applyReject(state);

    expect(state).toEqual({ phase: "waiting-for-scan", pairingCode: "1234", viewerUrl: VIEWER_URL, errorMessage: null });
  });

  it("after a reject, it can wait for the next pair-request and approve again (reject is not a terminal state)", () => {
    let state = initialHostSessionState;
    state = applyHostReady(state, HOST_READY, VIEWER_URL);
    state = applyPairRequest(state);
    state = applyReject(state);

    state = applyPairRequest(state); // a second viewer scanned the same QR code and re-paired
    expect(state.phase).toBe("confirm-pairing");
    state = applyApprove(state);
    expect(state.phase).toBe("transferring");
  });

  it("the expiry path: session-expired can happen in any phase, and always transitions to session-expired", () => {
    let state = initialHostSessionState;
    state = applyHostReady(state, HOST_READY, VIEWER_URL);
    state = applyPairRequest(state);
    state = applyApprove(state);

    state = applySessionExpired(state);

    expect(state.phase).toBe("session-expired");
    expect(state.errorMessage).toBeNull();
  });

  it("blocked before sending: send-blocked carries a reason, and a non-terminal phase means the session is still connected", () => {
    let state = initialHostSessionState;
    state = applyHostReady(state, HOST_READY, VIEWER_URL);
    state = applyPairRequest(state);
    state = applyApprove(state);

    state = applySendBlocked(state, "The story content exceeds the preview feature's size limits.");

    expect(state.phase).toBe("send-blocked");
    expect(state.errorMessage).toBe("The story content exceeds the preview feature's size limits.");
  });

  it("relay-error: receiving error{code} carries the matching explanation", () => {
    let state = initialHostSessionState;
    state = applyHostReady(state, HOST_READY, VIEWER_URL);

    state = applyRelayError(state, "protocol-violation");

    expect(state.phase).toBe("relay-error");
    expect(state.errorMessage).toContain("a protocol error occurred");
  });

  it("applyConnectionLost: disconnecting while still connecting -> relay-error (never successfully connected, a different feeling from \"was connected, then dropped\")", () => {
    const state = applyConnectionLost(initialHostSessionState);
    expect(state.phase).toBe("relay-error");
    expect(state.errorMessage).not.toBeNull();
  });

  it("applyConnectionLost: disconnecting after already reaching waiting-for-scan -> host-offline", () => {
    let state = initialHostSessionState;
    state = applyHostReady(state, HOST_READY, VIEWER_URL);

    state = applyConnectionLost(state);

    expect(state.phase).toBe("host-offline");
  });

  it("applyConnectionLost is a no-op on a state that's already terminal (ended/session-expired/relay-error)", () => {
    const endedState: HostSessionState = { phase: "ended", pairingCode: null, viewerUrl: null, errorMessage: null };
    expect(applyConnectionLost(endedState)).toEqual(endedState);

    const expiredState: HostSessionState = { phase: "session-expired", pairingCode: null, viewerUrl: null, errorMessage: null };
    expect(applyConnectionLost(expiredState)).toEqual(expiredState);
  });

  it("applyEnded: the user ends the preview, and any phase can transition to ended", () => {
    let state = initialHostSessionState;
    state = applyHostReady(state, HOST_READY, VIEWER_URL);
    state = applyPairRequest(state);

    state = applyEnded(state);

    expect(state.phase).toBe("ended");
  });

  it("applyPairRequest is a no-op outside the waiting-for-scan phase (a message that shouldn't happen, ignored as-is without aborting the session)", () => {
    let state = initialHostSessionState;
    state = applyHostReady(state, HOST_READY, VIEWER_URL);
    state = applyPairRequest(state);
    state = applyApprove(state); // now in transferring

    const unchanged = applyPairRequest(state);

    expect(unchanged).toEqual(state);
  });

  it("applyApprove/applyReject are no-ops outside the confirm-pairing phase", () => {
    const waiting = applyHostReady(initialHostSessionState, HOST_READY, VIEWER_URL);
    expect(applyApprove(waiting)).toEqual(waiting);
    expect(applyReject(waiting)).toEqual(waiting);
  });
});

describe("hostSession.ts - chunkBytes()/buildImageChunkMessages() (chunking)", () => {
  it("bytes smaller than one chunk - returns a single piece, unchanged length", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const chunks = chunkBytes(bytes, 10);
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0]!)).toEqual([1, 2, 3]);
  });

  it("boundary: exactly equal to maxChunkBytes - splits into just one piece", () => {
    const bytes = new Uint8Array(32 * 1024).fill(7);
    const chunks = chunkBytes(bytes, 32 * 1024);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length).toBe(32 * 1024);
  });

  it("boundary: 1 byte more than maxChunkBytes - splits into two pieces, the second only 1 byte", () => {
    const bytes = new Uint8Array(32 * 1024 + 1).fill(7);
    const chunks = chunkBytes(bytes, 32 * 1024);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBe(32 * 1024);
    expect(chunks[1]!.length).toBe(1);
  });

  it("a general case with a remainder: 2.5x maxChunkBytes - splits into three pieces, the last being the remainder", () => {
    const maxChunkBytes = 100;
    const bytes = new Uint8Array(250).map((_, i) => i % 256);
    const chunks = chunkBytes(bytes, maxChunkBytes);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    // Rejoining must equal the original bytes - chunking must never lose or duplicate a byte.
    const rejoined = new Uint8Array(250);
    let offset = 0;
    for (const c of chunks) {
      rejoined.set(c, offset);
      offset += c.length;
    }
    expect(Array.from(rejoined)).toEqual(Array.from(bytes));
  });

  it("the 0-byte boundary input - still returns exactly one (empty) piece, not 0 (ImageChunkMessage requires total > 0)", () => {
    const chunks = chunkBytes(new Uint8Array(0), 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length).toBe(0);
  });

  it("the default maxChunkBytes is exactly ./protocol.ts's MAX_CHUNK_BYTES (32 KiB) - the caps on both sides agree", () => {
    const bytes = new Uint8Array(MAX_CHUNK_BYTES + 1).fill(1);
    const chunks = chunkBytes(bytes);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBe(MAX_CHUNK_BYTES);
  });

  it("buildImageChunkMessages(): index increments contiguously from 0, total is consistent, and every message passes ./protocol.ts's isImageChunkMessage()", () => {
    const bytes = new Uint8Array(250).map((_, i) => i % 256);
    const messages = buildImageChunkMessages("img-1", bytes, 100);

    expect(messages).toHaveLength(3);
    messages.forEach((m, i) => {
      expect(m.type).toBe("image-chunk");
      expect(m.id).toBe("img-1");
      expect(m.index).toBe(i);
      expect(m.total).toBe(3);
      expect(isImageChunkMessage(m)).toBe(true);
    });

    // Decoding the base64 back out must equal the original bytes.
    const decoded = messages.flatMap((m) => Array.from(atob(m.dataBase64)).map((c) => c.charCodeAt(0)));
    expect(decoded).toEqual(Array.from(bytes));
  });
});

describe("hostSession.ts - checkSnapshotSize() (pre-send checks)", () => {
  const okSnapshot: PreviewSnapshot = {
    story: { title: "Sample Story", startPageId: "p1", pages: [{ id: "p1", text: "Once upon a time", choices: [] }] },
    images: [],
    revision: 1,
  };

  it("a normal snapshot passes the check", () => {
    expect(checkSnapshotSize(okSnapshot)).toEqual({ ok: true });
  });

  it("an image over the per-image size limit (MAX_IMAGE_BYTES) - fails, with a reason", () => {
    const oversized: PreviewSnapshot = {
      ...okSnapshot,
      images: [{ id: "img-1", mime: "image/png", byteLength: 6 * 1024 * 1024 }],
    };
    const result = checkSnapshotSize(oversized);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("a page count over PREVIEW_LIMITS.maxPages - fails", () => {
    const pages = Array.from({ length: 201 }, (_, i) => ({ id: `p${i}`, text: "x", choices: [] }));
    const tooManyPages: PreviewSnapshot = { story: { title: "x", startPageId: "p0", pages }, images: [], revision: 1 };
    const result = checkSnapshotSize(tooManyPages);
    expect(result.ok).toBe(false);
  });
});
