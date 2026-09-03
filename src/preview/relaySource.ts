// RelaySource - the real data source for the phone-QR-scan preview, replacing an earlier
// placeholder (see git history; the old version always returned a fixed
// "unavailable"). Gets viewerToken from the URL fragment, connects to relay, and walks the full
// pairing/transport protocol (see "Overview of roles and the pairing flow" in the ./protocol.ts
// header), finally turning ./source.ts's PreviewSource interface into a real implementation
// that can actually read what the phone should display.
//
// This file is one of the chunks reachable from the preview.html entry point (see ./main.ts) -
// scripts/smoke-build.ts mechanically verifies that every chunk from this entry point contains
// none of the strings modelContext/registerTool/indexedDB/update_page_text, so the import list
// here must stay within the boundary of "only touches ./protocol.ts + ./snapshot.ts +
// ./source.ts," and must not import anything under ../ui/**, ../webmcp/**, ../adapters/** -
// this file needs none of them (the protocol validation functions and the snapshot types are
// already in ./protocol.ts/./snapshot.ts).
//
// fail-closed is this file's one and only discipline: whenever any validation step fails, or a
// message has the wrong shape, always close the connection and report "unavailable" (or a more
// precise error the protocol explicitly names, like host-offline/expired/rejected), and never
// pretend to assemble a snapshot or image that's "probably right" - see the explanation for
// each case in #onMessage() below.
import {
  MAX_IMAGE_BYTES,
  MAX_SNAPSHOT_TOTAL_BYTES,
  VIEWER_TOKEN_PATTERN,
  deriveSid,
  isRelayToClientMessage,
  tryParseJson,
  type ClientToRelayMessage,
} from "./protocol.ts";
import type { PreviewImageMeta, PreviewSnapshot } from "./snapshot.ts";
import type { PreviewLoadResult, PreviewSource, PreviewSourceStatus } from "./source.ts";

/** relay's connection address - decided by the build environment (see
 * ../../.env.development / ../../.env.production, the "Preview" section of README.md). When
 * unset (an empty string/undefined, e.g. running `vite build` directly with no `.env.*` in
 * effect), `load()` always reports "unavailable" - this is "this deployment isn't wired up to
 * any relay at all," which feels the same to the user as "there's a relay but it can't be
 * reached" (retrying won't help either way), so it doesn't invent a separate new
 * PreviewSourceError type for it. */
const RELAY_URL = import.meta.env.VITE_PREVIEW_RELAY_URL as string | undefined;

/** How much of one image has been received so far - `total` starts at -1, meaning "no chunk
 * received yet, total chunk count unknown"; it gets locked in once the first chunk arrives
 * (every chunk after that is checked against this value, see the image-chunk branch of
 * #onMessage()). */
interface ImageProgress {
  total: number;
  nextIndex: number;
  bytesSoFar: number;
  readonly chunks: Uint8Array[];
}

function concatBytes(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** `atob()` throws on an invalid base64 string - ./protocol.ts's `isImageChunkMessage()`
 * already rejected bad character sets/length shapes upstream (see the image-chunk branch of
 * isRelayToClientMessage()), but that only validates "looks like base64," and doesn't
 * guarantee the browser's `atob()` can actually decode it successfully (e.g. an edge case with
 * padding in the wrong place) - this still wraps it in try/catch, fail-closed instead of
 * letting the exception blow up into an unhandled rejection. */
function decodeBase64(dataBase64: string): Uint8Array | undefined {
  try {
    const binary = atob(dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

/** Reads `#t=<viewerToken>` from `location.hash` and validates its shape, **clearing the
 * fragment immediately regardless of whether a valid value was found** - it's cleared the
 * moment it's read, so it's never left behind in history/screenshots -
 * `history.replaceState()` triggers no navigation/reload; it only rewrites the address bar and
 * the current history entry. */
function consumeViewerTokenFromLocation(): string | undefined {
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const token = new URLSearchParams(raw).get("t") ?? undefined;
  history.replaceState(null, "", location.pathname + location.search);
  return token !== undefined && VIEWER_TOKEN_PATTERN.test(token) ? token : undefined;
}

export class RelaySource implements PreviewSource {
  #ws: WebSocket | null = null;
  #loadPromise: Promise<PreviewLoadResult> | null = null;
  #statusCallback: ((status: PreviewSourceStatus) => void) | null = null;
  #manifest: PreviewSnapshot | null = null;
  #progress = new Map<string, ImageProgress>();
  #totalBytesSoFar = 0;
  #images = new Map<string, Uint8Array>();
  #disposed = false;

  onStatus(callback: (status: PreviewSourceStatus) => void): void {
    this.#statusCallback = callback;
  }

  #emitStatus(status: PreviewSourceStatus): void {
    this.#statusCallback?.(status);
  }

  /** Only the first call actually opens a connection - later calls (in theory this shouldn't
   * happen; ./reader.ts only calls this once, at mount) return the same in-flight/completed
   * Promise object (not "equal in value" but the same reference), without walking the pairing
   * flow again (viewerToken can only be used once - after an approve, a second hello with the
   * same token is always rejected by relay as token-consumed - see "Credential design" in the
   * ./protocol.ts header). Deliberately not declared `async` - even when an `async` function
   * `return`s another Promise, it still wraps it in a new Promise of its own, so the object
   * returned by two calls would not be the same reference; what's needed here is exactly that
   * same reference (the caller may use it to judge "is this the same load"), so this returns
   * `#loadPromise` itself directly. */
  load(): Promise<PreviewLoadResult> {
    if (!this.#loadPromise) this.#loadPromise = this.#connect();
    return this.#loadPromise;
  }

  async #connect(): Promise<PreviewLoadResult> {
    const token = consumeViewerTokenFromLocation();
    if (!token) return { ok: false, error: { type: "no-token" } };
    if (!RELAY_URL) return { ok: false, error: { type: "unavailable", reason: "VITE_PREVIEW_RELAY_URL is not set" } };

    this.#emitStatus({ kind: "connecting" });
    const sid = await deriveSid(token);

    return new Promise<PreviewLoadResult>((resolve) => {
      let settled = false;
      const finish = (result: PreviewLoadResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(`${RELAY_URL}/session?sid=${sid}`);
      } catch {
        finish({ ok: false, error: { type: "unavailable" } });
        return;
      }
      this.#ws = ws;

      const closeWs = () => {
        try {
          ws.close();
        } catch {
          // Already closing - nothing more to do.
        }
      };

      ws.addEventListener("open", () => this.#send(ws, { type: "hello", role: "viewer", token }));

      ws.addEventListener("message", (event: MessageEvent) => {
        if (this.#disposed) return;
        if (typeof event.data !== "string") {
          finish({ ok: false, error: { type: "unavailable" } });
          closeWs();
          return;
        }
        const parsed = tryParseJson(event.data);
        if (!parsed.ok || !isRelayToClientMessage(parsed.value)) {
          // fail-closed: bad JSON or a message with an invalid shape - don't guess intent,
          // just decide this connection is untrustworthy.
          finish({ ok: false, error: { type: "unavailable" } });
          closeWs();
          return;
        }
        const message = parsed.value;

        switch (message.type) {
          case "awaiting-approval":
            this.#emitStatus({ kind: "awaiting-approval", pairingCode: message.pairingCode });
            return;

          case "pair-approve":
            this.#emitStatus({ kind: "receiving" });
            this.#send(ws, { type: "snapshot-request" });
            return;

          case "pair-reject":
            finish({ ok: false, error: { type: "rejected" } });
            closeWs();
            return;

          case "snapshot-manifest": {
            // For the "snapshot-manifest" case, isRelayToClientMessage() has already called
            // isSnapshotManifestMessage() -> isPreviewSnapshot(), so by the time it gets here
            // message.snapshot is already a PreviewSnapshot with its shape and size caps
            // validated - no need to validate it again.
            this.#manifest = message.snapshot;
            this.#progress.clear();
            this.#totalBytesSoFar = 0;
            for (const meta of message.snapshot.images) {
              this.#progress.set(meta.id, { total: -1, nextIndex: 0, bytesSoFar: 0, chunks: [] });
            }
            return;
          }

          case "image-chunk": {
            // As above, the shape of message (the length and character set of
            // id/index/total/dataBase64) has already been validated; this only needs to check
            // the "business logic": was this image declared in the manifest, is the sequence
            // number contiguous, and does the accumulated byte count exceed the claimed size /
            // protocol cap. Any mismatch is fail-closed.
            if (!this.#manifest) {
              finish({ ok: false, error: { type: "unavailable" } });
              closeWs();
              return;
            }
            const meta: PreviewImageMeta | undefined = this.#manifest.images.find((img) => img.id === message.id);
            const progress = this.#progress.get(message.id);
            if (!meta || !progress) {
              finish({ ok: false, error: { type: "unavailable" } }); // The manifest never declared this image
              closeWs();
              return;
            }
            if (progress.total !== -1 && message.total !== progress.total) {
              finish({ ok: false, error: { type: "unavailable" } }); // This image's claimed total is inconsistent across chunks
              closeWs();
              return;
            }
            if (message.index !== progress.nextIndex) {
              finish({ ok: false, error: { type: "unavailable" } }); // The sequence number is not contiguous
              closeWs();
              return;
            }
            const bytes = decodeBase64(message.dataBase64);
            if (!bytes) {
              finish({ ok: false, error: { type: "unavailable" } });
              closeWs();
              return;
            }
            const bytesSoFar = progress.bytesSoFar + bytes.length;
            const totalBytesSoFar = this.#totalBytesSoFar + bytes.length;
            if (bytesSoFar > meta.byteLength || bytesSoFar > MAX_IMAGE_BYTES || totalBytesSoFar > MAX_SNAPSHOT_TOTAL_BYTES) {
              finish({ ok: false, error: { type: "unavailable" } }); // Exceeds the claimed size or the protocol cap
              closeWs();
              return;
            }
            progress.chunks.push(bytes);
            progress.nextIndex += 1;
            progress.bytesSoFar = bytesSoFar;
            progress.total = message.total;
            this.#totalBytesSoFar = totalBytesSoFar;
            return;
          }

          case "snapshot-complete": {
            if (!this.#manifest) {
              finish({ ok: false, error: { type: "unavailable" } });
              closeWs();
              return;
            }
            // Each image's accumulated byte count must be "exactly" equal to the byteLength
            // the manifest claimed - not just
            // "less than or equal is fine": receiving fewer bytes means the transfer was
            // interrupted somewhere, and an incomplete image must never be treated as
            // complete.
            for (const meta of this.#manifest.images) {
              const progress = this.#progress.get(meta.id);
              if (!progress || progress.bytesSoFar !== meta.byteLength) {
                finish({ ok: false, error: { type: "unavailable" } });
                closeWs();
                return;
              }
            }
            for (const meta of this.#manifest.images) {
              const progress = this.#progress.get(meta.id)!;
              this.#images.set(meta.id, concatBytes(progress.chunks, progress.bytesSoFar));
            }
            finish({ ok: true, snapshot: this.#manifest });
            closeWs(); // The snapshot and all image bytes are already in memory - this connection is no longer needed.
            return;
          }

          case "host-offline":
            finish({ ok: false, error: { type: "host-offline" } });
            return;

          case "session-expired":
            finish({ ok: false, error: { type: "expired" } });
            return;

          case "error":
            finish({ ok: false, error: { type: "unavailable", reason: message.code } });
            return;

          default:
            // host-ready/pair-request are host-only and, in theory, should never be sent to
            // the viewer's connection - fail-closed and ignore it, without guessing intent.
            return;
        }
      });

      ws.addEventListener("close", () => {
        // Disconnected before snapshot-complete arrived - always report
        // host-offline (regardless of why the connection dropped, it feels the same to the
        // viewer: the content is unreachable). The `settled` guard built into `finish()`
        // guarantees this cannot overwrite a result already finalized by some other message
        // (pair-reject/session-expired/error/snapshot-complete).
        finish({ ok: false, error: { type: "host-offline" } });
      });

      ws.addEventListener("error", () => {
        finish({ ok: false, error: { type: "unavailable" } });
      });
    });
  }

  #send(ws: WebSocket, message: ClientToRelayMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // The other end has already disconnected - nothing more to do; the close event will
      // take over handling the outcome.
    }
  }

  async image(id: string): Promise<Uint8Array | undefined> {
    return this.#images.get(id);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        // Already closing - nothing more to do.
      }
    }
  }
}
