// Deterministic file validation: extension + magic bytes checked against the media/ allowlist
// (png/jpg/jpeg/webp -- this repo's scope is images only), size <=
// workspace/limits.ts's existing MAX_BLOB, contentHash via
// crypto.subtle.digest("SHA-256") (a web API, allowed; kept in the
// adapter/service layer so the domain machine stays purely synchronous) --
// this file is therefore async (crypto.subtle.digest is an async web API) and
// never touches storage/workspace; it is a pure input-computation dependency.
//
// The sole caller is
// ../media/setPageImage.ts (the agent supplies images directly, with no manual
// approval step), reusing the same "extension matches magic bytes" deterministic
// validation instead of writing a second copy.
//
// The extension allowlist and magic-byte signatures line up with
// ../workspace/paths.ts's MEDIA_FILE_PATTERN
// (one shared allowlist can only have one authority -- this file is the source
// of truth for "which extensions are legal"; paths.ts's regex is the source of
// truth for "path shape". Both describe the same ext list, each owning its own
// concern).
//
// "Extension matches magic bytes" instead of trusting either one alone: the
// caller-declared extension (from a user-picked file) may be a filename that
// was casually renamed, or the content itself may be corrupted/disguised --
// both must agree here to pass; either side being wrong is a deterministic,
// reproducible rejection (the same bytes always produce the same result, with
// no time/randomness/network dependency).
import { MAX_BLOB_FILE_BYTES } from "../workspace/limits.ts";

// Deliberately not annotated as `Record<string, ...>` -- a named index
// signature like that would widen `keyof typeof EXT_KIND` down to a generic
// `string`, instead of the 4-literal union we need (ImageExt's
// definition below depends on the concrete literal keys being preserved here).
// `as const` + Object.freeze stack two guarantees: the former makes the type
// system remember the literals, the latter makes it actually immutable at
// runtime.
const EXT_KIND = Object.freeze({
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
} as const);

export type ImageExt = keyof typeof EXT_KIND;

const ALLOWED_EXTS: ReadonlySet<string> = new Set(Object.keys(EXT_KIND));

export function isAllowedImageExt(value: string): value is ImageExt {
  return ALLOWED_EXTS.has(value);
}

/** Extracts the extension from a filename (lowercased). No `.`, or the `.`
 * appears as the first character (a dotfile like ".png"), or the `.` is the
 * last character (no actual extension content) -- all of these count as
 * "no usable extension" and return undefined, so callers all fall through the
 * same "unsupported extension" rejection path without needing separate cases. */
function extractExt(filename: string): string | undefined {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0 || idx === filename.length - 1) return undefined;
  return filename.slice(idx + 1).toLowerCase();
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function matchesAsciiAt(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Magic-byte signature for each allowed extension -- a minimal deterministic
 * check that "the content really does look like this format", not full file
 * format validation (it doesn't parse the internal structure, only the header).
 *
 *   - png: the standard 8-byte PNG signature.
 *   - jpg/jpeg: the SOI marker shared by JFIF/Exif (FF D8 FF).
 *   - webp: the RIFF container + "WEBP" ASCII at offset 8 (RIFF....WEBP).
 */
function matchesMagicBytes(ext: ImageExt, bytes: Uint8Array): boolean {
  switch (ext) {
    case "png":
      return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "jpg":
    case "jpeg":
      return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
    case "webp":
      return startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && matchesAsciiAt(bytes, 8, "WEBP");
  }
}

function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ImageFileValidationInput {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

/**
 * The validation result is a three-way state, not a boolean ok/false --
 *   - "valid": extension/size/magic bytes/hash all passed.
 *   - "invalid": something is wrong with the file itself (unsupported
 *     extension, too large, magic bytes don't match, ...) -- this is a
 *     problem with "this image"; the caller (../media/setPageImage.ts) turns
 *     it into a structured `SetPageImageError` (the `"invalid-image"` branch
 *     etc.) so the agent knows "this image was rejected, and why".
 *   - "unavailable": the environment itself can't compute SHA-256
 *     (`crypto.subtle` is `undefined` on a non-secure context, e.g. http that
 *     isn't localhost; or calling `crypto.subtle.digest()` itself throws) --
 *     this is not a problem with "this file", it's a problem with "this
 *     browser tab's current execution environment". Callers **must not** land
 *     this as invalid (that would mislead the caller into thinking the image
 *     itself is broken, and regenerating one wouldn't help) -- instead report
 *     it as a structured service-layer error with zero storage writes (see
 *     ../media/setPageImage.ts's `SetPageImageError` `"hash-unavailable"`
 *     branch).
 */
export type ImageFileValidationResult =
  | { readonly status: "valid"; readonly ext: ImageExt; readonly contentHash: string }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * Deterministically validates a single image file -- the same
 * (filename, bytes) input always produces the same output (the contentHash
 * step itself is a pure-function mathematical computation with no
 * time/randomness/network dependency; whether `crypto.subtle` exists is a
 * fact about the execution environment, not about this file -- see the
 * `"unavailable"` explanation above). Validation order (any failed check
 * returns early, skipping the rest):
 *   1. extension is in the allowlist (png/jpg/jpeg/webp)
 *   2. bytes is non-empty and its size is <= MAX_BLOB_FILE_BYTES
 *   3. magic bytes match the format signature for the extension
 *   4. the `crypto.subtle` API itself exists in the current environment --
 *      if not, that's "unavailable", and we stop there.
 *   5. only once everything passes do we compute contentHash (SHA-256 hex) --
 *      no need to pay that computation cost otherwise; the `digest()` call
 *      itself is still wrapped in try/catch (some browsers can throw
 *      `NotSupportedError` or similar for particular inputs, not just the
 *      "the whole API doesn't exist" shape of unavailability).
 */
export async function validateImageFile(input: ImageFileValidationInput): Promise<ImageFileValidationResult> {
  const ext = extractExt(input.filename);
  if (ext === undefined || !isAllowedImageExt(ext)) {
    return {
      status: "invalid",
      reason: `unsupported extension (only png/jpg/jpeg/webp accepted): "${input.filename}"`,
    };
  }

  if (input.bytes.length === 0) {
    return { status: "invalid", reason: "file content is empty" };
  }
  if (input.bytes.length > MAX_BLOB_FILE_BYTES) {
    return {
      status: "invalid",
      reason: `file size ${input.bytes.length} bytes exceeds the per-file limit of ${MAX_BLOB_FILE_BYTES} bytes`,
    };
  }

  if (!matchesMagicBytes(ext, input.bytes)) {
    return {
      status: "invalid",
      reason: `file content (magic bytes) doesn't match extension ".${ext}" -- possibly a disguised or corrupted file`,
    };
  }

  if (typeof crypto === "undefined" || !crypto.subtle) {
    return { status: "unavailable", reason: "this environment doesn't support SHA-256 (crypto.subtle is absent); https or localhost access is required" };
  }

  // crypto.subtle.digest requires that the BufferSource is backed by a plain
  // ArrayBuffer (the type can't rule out SharedArrayBuffer) --
  // `new Uint8Array(input.bytes)` copies out a guaranteed-clean copy before
  // taking .buffer -- not a cast that bypasses the type check.
  const copy = new Uint8Array(input.bytes);
  try {
    const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
    return { status: "valid", ext, contentHash: toHex(digest) };
  } catch {
    return { status: "unavailable", reason: "this environment doesn't support SHA-256; https or localhost access is required" };
  }
}
