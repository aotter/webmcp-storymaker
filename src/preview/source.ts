// PreviewSource - the only data-source interface PreviewReader
// (./reader.ts) knows how to read. The creator's local preview and the phone-QR-scan preview
// only switch "where the snapshot comes from" through this adapter; PreviewReader itself has
// no idea whether, underneath, it's the same tab's IndexedDB workspace (LocalSource in
// ./localSource.ts) or data relayed from the creator's tab over an encrypted connection to the
// phone (RelaySource, see ./relaySource.ts) - PreviewReader is a single
// shared component, and both sides only switch data sources through the PreviewSource adapter.
//
// This file only defines types - zero I/O, zero implementation - LocalSource/RelaySource each
// implement this interface, and PreviewReader depends only on the shapes here; none of the
// three needs to know the others' implementation details.
import type { PreviewSnapshot } from "./snapshot.ts";

/**
 * PreviewReader shows a fixed English message for each type (see
 * ./messages.ts formatPreviewSourceError()) - this is a closed enum, not an open string that
 * can be extended freely; adding a new error means deciding "which fixed message the reader
 * shows" at the same time, not just adding a type here and calling it done.
 *
 * The first three are the ones LocalSource actually uses:
 *   - "no-story": this tab's workspace doesn't have any story yet (story.yaml doesn't exist).
 *   - "invalid-story": the story exists, but its current content cannot be safely turned into
 *     a preview snapshot - either story.yaml itself is corrupted, structure validate() found
 *     errors, or the assembled snapshot exceeds any of ../preview/snapshot.ts's PREVIEW_LIMITS
 *     (see ./buildPreviewSnapshot.ts).
 *   - "unavailable": a transient read failure that a retry might fix - LocalSource uses this
 *     when workspace tear-read retries are exhausted (same semantics as workspace-busy in
 *     ../story/readiness.ts). RelaySource also uses it to describe retryable
 *     states like "the connection hasn't been established yet / temporarily dropped but not
 *     confirmed expired."
 *
 * The next three are used by RelaySource:
 *   - "expired": the preview connection/session has expired (e.g. the QR link the phone
 *     scanned timed out).
 *   - "host-offline": the creator's tab has gone offline/closed, so there's nothing left to
 *     relay.
 *   - "rejected": the creator explicitly declined this preview request.
 *
 * The seventh type is RelaySource-only:
 *   - "no-token": the phone-side URL's fragment doesn't carry a valid `#t=<viewerToken>`
 *     (the field is missing, or its format doesn't match ../preview/protocol.ts's
 *     VIEWER_TOKEN_PATTERN) - this isn't "the connection failed," it's that there was never any
 *     credential to connect with in the first place; it can only happen when the user did not
 *     open this page via the creator's QR code (e.g. they typed the URL by hand, or someone
 *     shared a truncated link).
 *
 * `reason` is for logging/debugging only (it may contain technical strings); the fixed message
 * the reader shows never reads it - never show the raw contents of `reason` to the reader.
 */
export type PreviewSourceError =
  | { readonly type: "no-story" }
  | { readonly type: "invalid-story"; readonly reason?: string }
  | { readonly type: "unavailable"; readonly reason?: string }
  | { readonly type: "expired" }
  | { readonly type: "host-offline" }
  | { readonly type: "rejected" }
  | { readonly type: "no-token" };

export type PreviewLoadResult =
  | { readonly ok: true; readonly snapshot: PreviewSnapshot }
  | { readonly ok: false; readonly error: PreviewSourceError };

/** RelaySource's `load()` doesn't resolve from a single read - it passes through
 * stages of "connecting -> waiting for the creator to approve pairing (the phone side needs to
 * see the pairing code, to cross-check against the creator's screen) -> paired, receiving the
 * snapshot," and `load()`'s own Promise stays unresolved for the whole stretch.
 * PreviewReader wants to show something during that wait (especially the pairing code - this
 * is information the user genuinely needs to see and cross-check against the creator's screen;
 * it can't be buried inside one generic "loading..." message), so it needs a progress-
 * notification channel separate from `load()`'s return value.
 *
 * Only three stages are worth exposing to the reader (a closed enum, following the same
 * discipline as PreviewSourceError) - LocalSource's read has no such multi-stage process, so
 * it neither needs nor calls this channel. */
export type PreviewSourceStatus =
  | { readonly kind: "connecting" }
  | { readonly kind: "awaiting-approval"; readonly pairingCode: string }
  | { readonly kind: "receiving" };

export interface PreviewSource {
  /** Reads the full snapshot of "the currently readable story" (excluding image bytes, see the
   * ../preview/snapshot.ts header). Every call is a fresh read, zero caching - PreviewReader
   * only calls it once, on mount (reading state lives only in memory, with no
   * requirement for background polling/refresh). */
  load(): Promise<PreviewLoadResult>;
  /** Reads the full bytes for one illustration - `id` is always a
   * `PreviewSnapshot.images[].id` returned by some `load()` call. Returns `undefined` if not
   * found (fail-closed, never fabricates a blank image); it's up to the caller to decide what
   * placeholder to show. */
  image(id: string): Promise<Uint8Array | undefined>;
  /** Releases any resources this source instance holds (connections, listeners, ...) -
   * LocalSource has no such resources, so this is a no-op; RelaySource closes the underlying
   * WebSocket connection here. The caller (`dispose()` in ./reader.ts's
   * mountPreviewReader()) guarantees this is called at most once. */
  dispose(): void;
  /** Optional - a stage notification while `load()` is in progress
   * (see the PreviewSourceStatus header). Only RelaySource implements it; LocalSource does not
   * define this method at all (it's optional on the interface as `onStatus?(...)`, so
   * TypeScript does not require implementing classes to add a no-op). The caller (./reader.ts)
   * registers by calling `source.onStatus?.(callback)` **before** calling `load()`, so it
   * doesn't miss the first status `load()` might emit right at the start. It's only guaranteed
   * to be called once (reader.ts only registers once, at mount) - it is not an event bus that
   * supports subscribing multiple callbacks. */
  onStatus?(callback: (status: PreviewSourceStatus) => void): void;
}
