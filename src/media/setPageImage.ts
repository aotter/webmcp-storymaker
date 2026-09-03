// The "AI supplies images
// directly" write path. The agent calls in here
// via the WebMCP `set_page_image` tool (../webmcp/tools/writeTools.ts), and
// within a single mutate() writes the base64 image to
// `media/<chapterSlug>.<ext>` plus updates the `media.json` entry -- there is
// no manual approval step.
//
// mediaSlug === chapterSlug follows the existing rule (../map/model.ts
// header, "the basis for the page <-> art mapping"): a page
// has only one currently-effective illustration, and the agent overwrites it
// directly when supplying a new image, so a separate mediaSlug concept is
// not needed (the agent only needs to know the chapterSlug when calling
// this tool).
//
// Validation reuses ../media/fileValidation.ts's validateImageFile()
// (extension + magic bytes + size) -- the same deterministic validation
// logic, not rewritten a second time. This code doesn't need the
// contentHash it computes, but calling it still computes one anyway --
// because the
// magic-byte check and the hash computation are coupled inside the same
// function, and splitting them apart would mean maintaining two copies of the
// validation logic; the computation cost is negligible for a single image.
//
// Consistent reads (following the existing skeleton
// in ../story/readiness.ts): expectedRevision needs to line up with both
// story.yaml (whether chapterSlug exists) and media.json (whether to keep
// existing entries for other slugs) -- both are confirmed together in one
// round via ../workspace/snapshot.ts's readConsistentSnapshot(); any tearing
// on either side means the whole round retries, and once the retry limit is
// exhausted this reports workspace-busy.
import type { WorkspaceStoragePort } from "../ports.ts";
import { readStory } from "../story/readStory.ts";
import { collectReferencedChapterSlugs } from "../story/refs.ts";
import { CONSISTENT_READ_MAX_ATTEMPTS, readConsistentSnapshot } from "../workspace/snapshot.ts";
import { MAX_BLOB_FILE_BYTES } from "../workspace/limits.ts";
import { PREVIEW_LIMITS } from "../preview/snapshot.ts";
import type { WorkspaceMutationError, WorkspaceWriteOp } from "../workspace/types.ts";
import { parseMediaJson, type MediaJsonShape } from "../workspace/media.ts";
import type { ReadStoryError } from "../story/types.ts";
import { validateImageFile, type ImageExt } from "./fileValidation.ts";

const MEDIA_JSON_PATH = "media.json";

/** This tool's image size limit -- the stricter of the workspace's per-file
 * blob limit (50MiB) and the preview snapshot's image limit (5MiB,
 * ../preview/snapshot.ts's PREVIEW_LIMITS.maxImageBytes): an image bigger
 * than the preview limit will still get written into the workspace, but
 * buildPreviewSnapshot() will judge it invalid-story the next time a
 * phone/computer preview builds a snapshot -- better to honestly reject it
 * right at write time (this enforces both workspace/limits.ts's MAX_BLOB
 * and PREVIEW_LIMITS.maxImageBytes). */
export const SET_PAGE_IMAGE_MAX_BYTES = Math.min(MAX_BLOB_FILE_BYTES, PREVIEW_LIMITS.maxImageBytes);

/** Upper bound on the length of the base64-encoded (with padding) string --
 * without this, decoding would call `decodeBase64()` first, decoding the
 * entire base64 payload into memory before checking its size via
 * `bytes.length`, so a many-hundred-MB `imageBase64` would get fully decoded
 * into memory before being rejected. base64 encodes every 3 raw bytes into 4
 * characters (with padding), so `Math.ceil(SET_PAGE_IMAGE_MAX_BYTES / 3) * 4`
 * is the maximum encoded-string length that can occur when the decoded size
 * is exactly at the limit -- an encoded string longer than this must, no
 * matter its content, decode to more bytes than `SET_PAGE_IMAGE_MAX_BYTES`,
 * so we can decide to reject without ever decoding, catching it before
 * `atob()` (rather than after) -- fail-closed as early as possible. */
export const MAX_BASE64_LENGTH = Math.ceil(SET_PAGE_IMAGE_MAX_BYTES / 3) * 4;

const MIME_TO_EXT: Readonly<Record<string, ImageExt>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Extensions to try in order when mimeType is absent -- jpg's magic-byte
 * signature is the same as jpeg's (../media/fileValidation.ts
 * matchesMagicBytes), so trying "jpg" already covers both. */
const SNIFF_ORDER: readonly ImageExt[] = ["png", "jpg", "webp"];

export interface SetPageImageInput {
  readonly expectedRevision: number;
  readonly storySlug: string;
  readonly chapterSlug: string;
  readonly imageBase64: string;
  readonly mimeType?: string;
}

export type SetPageImageError =
  | ReadStoryError
  | { readonly type: "story-mismatch"; readonly expectedStorySlug: string; readonly actualStorySlug: string }
  | { readonly type: "chapter-not-found"; readonly knownChapterSlugs: readonly string[] }
  | { readonly type: "invalid-base64"; readonly reason: string }
  | { readonly type: "empty-image" }
  | { readonly type: "image-too-large"; readonly byteLength: number; readonly maxBytes: number }
  | { readonly type: "unsupported-mime-type"; readonly mimeType: string }
  | { readonly type: "invalid-image"; readonly reason: string }
  | { readonly type: "hash-unavailable"; readonly reason: string }
  | { readonly type: "media-json-corrupt"; readonly reason: string }
  | { readonly type: "mutation-rejected"; readonly error: WorkspaceMutationError };

export type SetPageImageResult = { readonly ok: true; readonly revision: number } | { readonly ok: false; readonly error: SetPageImageError };

function decodeBase64(value: string): { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: string } {
  let binary: string;
  try {
    binary = atob(value);
  } catch (error) {
    return { ok: false, reason: `base64 decode failed: ${(error as Error).message}` };
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { ok: true, bytes };
}

async function sniffExt(
  bytes: Uint8Array,
): Promise<{ readonly ok: true; readonly ext: ImageExt } | { readonly ok: false; readonly error: SetPageImageError }> {
  let lastInvalidReason: string | undefined;
  for (const ext of SNIFF_ORDER) {
    const validation = await validateImageFile({ filename: `page.${ext}`, bytes });
    if (validation.status === "valid") return { ok: true, ext: validation.ext };
    if (validation.status === "unavailable") return { ok: false, error: { type: "hash-unavailable", reason: validation.reason } };
    lastInvalidReason = validation.reason;
  }
  return { ok: false, error: { type: "invalid-image", reason: lastInvalidReason ?? "image content doesn't match any supported format (png/jpg/jpeg/webp)" } };
}

async function resolveExt(
  bytes: Uint8Array,
  mimeType: string | undefined,
): Promise<{ readonly ok: true; readonly ext: ImageExt } | { readonly ok: false; readonly error: SetPageImageError }> {
  if (mimeType === undefined) return sniffExt(bytes);

  const ext = MIME_TO_EXT[mimeType];
  if (ext === undefined) return { ok: false, error: { type: "unsupported-mime-type", mimeType } };

  const validation = await validateImageFile({ filename: `page.${ext}`, bytes });
  if (validation.status === "valid") return { ok: true, ext: validation.ext };
  if (validation.status === "unavailable") return { ok: false, error: { type: "hash-unavailable", reason: validation.reason } };
  return { ok: false, error: { type: "invalid-image", reason: validation.reason } };
}

export async function setPageImage(storage: WorkspaceStoragePort, input: SetPageImageInput): Promise<SetPageImageResult> {
  // Defensive: the caller (../webmcp/tools/writeTools.ts) has already validated
  // the type at the schema boundary, but this code doesn't assume "this call
  // site currently looks safe" -- setPageImage() itself is also an exported
  // function that can be called directly, and the same discipline requires
  // each layer to guard its own input (the same spirit as
  // ../webmcp/tools/writeTools.ts's sanitizeSpecInput()). The type check must
  // come **before** the length check: the length check reads `.length`, and
  // calling that on a non-string value throws an uncaught TypeError.
  if (typeof input.imageBase64 !== "string") {
    return { ok: false, error: { type: "invalid-base64", reason: "imageBase64 must be a string" } };
  }

  // The size check must happen before `decodeBase64()`, using
  // the length of the encoded string itself to block early -- see
  // MAX_BASE64_LENGTH's explanation; we can't decode the entire base64
  // payload into memory first and only then discover it's too large.
  if (input.imageBase64.length > MAX_BASE64_LENGTH) {
    // The byte count is an estimate (derived from base64's standard 3:4 ratio,
    // without an exact deduction for padding) -- this is only the "definitely
    // over the limit" early-exit path, not an exact computation; the caller
    // only needs to know "it's too large" and what the limit is (the existing
    // field contract for SafeSetPageImageError already allows byteLength to
    // be a number the server computed -- see ../webmcp/tools/writeTools.ts).
    const estimatedByteLength = Math.floor((input.imageBase64.length * 3) / 4);
    return { ok: false, error: { type: "image-too-large", byteLength: estimatedByteLength, maxBytes: SET_PAGE_IMAGE_MAX_BYTES } };
  }

  const decoded = decodeBase64(input.imageBase64);
  if (!decoded.ok) return { ok: false, error: { type: "invalid-base64", reason: decoded.reason } };
  const { bytes } = decoded;

  if (bytes.length === 0) return { ok: false, error: { type: "empty-image" } };
  if (bytes.length > SET_PAGE_IMAGE_MAX_BYTES) {
    return { ok: false, error: { type: "image-too-large", byteLength: bytes.length, maxBytes: SET_PAGE_IMAGE_MAX_BYTES } };
  }

  const resolved = await resolveExt(bytes, input.mimeType);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const ext = resolved.ext;

  for (let attempt = 1; attempt <= CONSISTENT_READ_MAX_ATTEMPTS; attempt++) {
    const current = await readStory(storage);
    if (!current.ok) return { ok: false, error: current.error };

    if (current.spec.metadata.slug !== input.storySlug) {
      return {
        ok: false,
        error: { type: "story-mismatch", expectedStorySlug: input.storySlug, actualStorySlug: current.spec.metadata.slug },
      };
    }
    if (current.revision !== input.expectedRevision) {
      return {
        ok: false,
        error: {
          type: "mutation-rejected",
          error: { type: "revision-conflict", expectedRevision: input.expectedRevision, actualRevision: current.revision },
        },
      };
    }

    const knownChapterSlugs = collectReferencedChapterSlugs(current.spec);
    if (!knownChapterSlugs.has(input.chapterSlug)) {
      return { ok: false, error: { type: "chapter-not-found", knownChapterSlugs: [...knownChapterSlugs].sort() } };
    }

    const extra = await readConsistentSnapshot(storage, async (before) => {
      const hasMediaJson = before.entries.some((e) => e.path === MEDIA_JSON_PATH);
      const file = hasMediaJson ? await storage.readFile(MEDIA_JSON_PATH) : undefined;
      return file?.kind === "text" ? file.text : undefined;
    });
    if (!extra.ok) continue; // media.json/file-list read tore -- retry the whole round
    if (extra.snapshot.revision !== current.revision) continue; // something changed again after readStory() -- retry the whole round

    const mediaJson = parseMediaJson(extra.value, knownChapterSlugs);
    if (!mediaJson.ok) return { ok: false, error: { type: "media-json-corrupt", reason: mediaJson.reason } };

    // chapterSlug is already guaranteed by knownChapterSlugs.has() above to be a
    // member of the set returned by collectReferencedChapterSlugs() -- that
    // set can only contain values constrained by CHAPTER_REF_RE
    // (^[a-z0-9-]+$) (see the existing precedent explained in
    // ../ui/controller.ts's readAcceptedMedia()), so interpolating it
    // directly needs no escaping.
    const mediaPath = `media/${input.chapterSlug}.${ext}`;
    const oldFilePattern = new RegExp(`^media/${input.chapterSlug}\\.(?:png|jpg|jpeg|webp)$`);

    const ops: WorkspaceWriteOp[] = [];
    // If the same page already has an image, overwrite it (delete the old file
    // if the extension changed). When the extension stays
    // the same, the "write" above is itself an overwrite, so no extra delete
    // is needed.
    for (const entry of extra.snapshot.entries) {
      if (entry.kind === "blob" && entry.path !== mediaPath && oldFilePattern.test(entry.path)) {
        ops.push({ op: "delete", path: entry.path });
      }
    }
    ops.push({ op: "write", path: mediaPath, kind: "blob", bytes });
    const nextMediaJson: MediaJsonShape = {
      ...mediaJson.value,
      [input.chapterSlug]: { file: `${input.chapterSlug}.${ext}` },
    };
    ops.push({ op: "write", path: MEDIA_JSON_PATH, kind: "text", text: `${JSON.stringify(nextMediaJson, null, 2)}\n` });

    const mutation = await storage.mutate({ expectedRevision: current.revision, ops });
    if (!mutation.ok) return { ok: false, error: { type: "mutation-rejected", error: mutation.error } };
    return { ok: true, revision: mutation.revision };
  }

  return {
    ok: false,
    error: {
      type: "workspace-busy",
      reason: `the workspace kept changing while writing the image; still couldn't get a consistent snapshot after ${CONSISTENT_READ_MAX_ATTEMPTS} retries -- please try again later`,
    },
  };
}
