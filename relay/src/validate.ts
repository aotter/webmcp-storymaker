// The relay's own copy of runtime message shape validation -- see the "boundary decision on file
// location" note in ../../src/preview/protocol.ts's header: relay only does a type-only import of
// the types, and doesn't import protocol.ts's validation function bodies, so this is a standalone
// implementation. "What the wire shapes look like" must agree between the two sides, but the
// implementations are independent -- whenever you change a message shape on either side, be sure to
// check the other side too.
//
// One deliberate difference from protocol.ts: this file only does **shallow validation** of
// snapshot-manifest's snapshot field (whether story is an object, whether images is an array whose
// items have the right "id/mime/byteLength" shape and are within the size cap, whether revision is
// an integer) -- it doesn't validate every field of story.pages/choices in depth. The reason: the
// DO doesn't parse story content, it only validates the message envelope's
// shape (type, size, sequence continuity) -- deeply validating the story's internal structure is
// already outside the scope of "envelope shape"; that's each side's own responsibility (the web
// app, on the host side producing the snapshot and on the viewer side rendering it), and
// protocol.ts's isPreviewSnapshot() is the authoritative implementation of that full validation.
//
// Another deliberate difference: image-chunk's dataBase64 "is the character set/length a multiple
// of 4" and "does the length exceed the cap" are split into two separate checks here (protocol.ts
// merges them into one boolean), because the relay needs to distinguish protocol-violation (the
// format itself is wrong) from too-large (the format is fine, it's just over the size cap) -- these
// two need to return different error codes to the caller, a distinction protocol.ts's version
// doesn't need (it only needs one overall "is this valid or not" boolean).

import {
  HOST_KEY_PATTERN,
  MAX_CHUNK_BASE64_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_ID_LENGTH,
  MAX_SNAPSHOT_TOTAL_BYTES,
  VIEWER_TOKEN_PATTERN,
} from "./protocol-limits.ts";

/** The shape of a host-role hello -- see "credential design" in ../../src/preview/protocol.ts. */
export interface HostHelloShape {
  readonly type: "hello";
  readonly role: "host";
  readonly hostKey: string;
}

/** The shape of a viewer-role hello. */
export interface ViewerHelloShape {
  readonly type: "hello";
  readonly role: "viewer";
  readonly token: string;
}

export interface ImageChunkShape {
  readonly type: "image-chunk";
  readonly id: string;
  readonly index: number;
  readonly total: number;
  readonly dataBase64: string;
}

export interface SnapshotManifestShape {
  readonly type: "snapshot-manifest";
  readonly snapshot: {
    readonly story: unknown;
    readonly images: readonly { readonly id: string; readonly byteLength: number }[];
    readonly revision: number;
  };
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isBoundedString(x: unknown, maxLength: number): x is string {
  return typeof x === "string" && x.length > 0 && x.length <= maxLength;
}

function isNonNegativeInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
function isBase64Charset(x: unknown): x is string {
  return typeof x === "string" && x.length > 0 && x.length % 4 === 0 && BASE64_RE.test(x);
}

const PREVIEW_IMAGE_MIME_VALUES = ["image/png", "image/jpeg", "image/webp"];

/** A safe JSON.parse -- returns a Result so the caller doesn't need to wrap it in its own
 * try/catch (same rationale as protocol.ts's tryParseJson, and the same reason this is a
 * standalone implementation). */
export function tryParseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

export function isHostHelloShape(x: unknown): x is HostHelloShape {
  return isPlainObject(x) && x.type === "hello" && x.role === "host" && typeof x.hostKey === "string" && HOST_KEY_PATTERN.test(x.hostKey);
}

export function isViewerHelloShape(x: unknown): x is ViewerHelloShape {
  return isPlainObject(x) && x.type === "hello" && x.role === "viewer" && typeof x.token === "string" && VIEWER_TOKEN_PATTERN.test(x.token);
}

/** image-chunk's "format shape" -- charset/length is a multiple of 4. **Does not** include the
 * size-cap check; the caller (session-do.ts) checks that separately with exceedsChunkSizeCap(),
 * see the file header for why. */
export function isImageChunkShape(x: unknown): x is ImageChunkShape {
  return (
    isPlainObject(x) &&
    x.type === "image-chunk" &&
    isBoundedString(x.id, MAX_IMAGE_ID_LENGTH) &&
    isNonNegativeInt(x.index) &&
    isNonNegativeInt(x.total) &&
    x.total > 0 &&
    x.index < x.total &&
    isBase64Charset(x.dataBase64)
  );
}

export function exceedsChunkSizeCap(dataBase64: string): boolean {
  return dataBase64.length > MAX_CHUNK_BASE64_LENGTH;
}

/** An estimate of the decoded byte count of a base64 string (doesn't actually decode -- just uses
 * the length formula) -- used to compare "the total bytes received so far for this image" against
 * the byteLength the manifest claimed, to block amplification attacks like "the manifest claims a
 * small size but chunks keep pouring in far beyond it". An estimate, not required to be exact to
 * the byte. */
export function estimateBase64DecodedLength(dataBase64: string): number {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.floor((dataBase64.length * 3) / 4) - padding;
}

function isPreviewImageMetaShapeShallow(x: unknown): x is { id: string; byteLength: number } {
  return (
    isPlainObject(x) &&
    isBoundedString(x.id, MAX_IMAGE_ID_LENGTH) &&
    typeof x.mime === "string" &&
    PREVIEW_IMAGE_MIME_VALUES.includes(x.mime) &&
    isNonNegativeInt(x.byteLength) &&
    x.byteLength > 0 &&
    x.byteLength <= MAX_IMAGE_BYTES
  );
}

/** snapshot-manifest's envelope shape -- see the "deliberate differences" note in the file header;
 * only validates that story is an object, that each item in the images array has the right
 * metadata shape and is within the size cap, and that revision is an integer -- doesn't go deep
 * into story's internal fields. */
export function isSnapshotManifestShape(x: unknown): x is SnapshotManifestShape {
  if (!isPlainObject(x) || x.type !== "snapshot-manifest") return false;
  const snapshot = x.snapshot;
  if (!isPlainObject(snapshot)) return false;
  if (!isPlainObject(snapshot.story)) return false;
  if (!Array.isArray(snapshot.images) || !snapshot.images.every((img) => isPreviewImageMetaShapeShallow(img))) return false;
  if (!isNonNegativeInt(snapshot.revision)) return false;
  const total = (snapshot.images as readonly { byteLength: number }[]).reduce((sum, img) => sum + img.byteLength, 0);
  return total <= MAX_SNAPSHOT_TOTAL_BYTES;
}
