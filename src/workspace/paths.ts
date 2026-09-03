// Workspace relative-path allowlist rules (pure function, zero external dependencies, zero
// browser APIs).
//
// Shape derived from docs/STORYSPEC.md's reference schemes:
// CHAPTER_SLUG_RE (`^[a-z0-9-]+$`), fixed English content, MEDIA_SLUG_RE (`^[a-z0-9-]+$`),
// and an extension allowlist (png/jpg/jpeg/webp -> image; this repo's scope is images only).
//
// Design decision: this package currently holds only a single story's workspace (see
// docs/architecture.md's "the browser story is a new, locally-held YAML workspace" -- one
// IndexedDB workspace = one story), so paths don't include a "story slug" directory layer.
// Whether to support one browser workspace holding multiple stories is left for a later
// evaluation -- hard-coding a multi-story layer now would be speculative design with no user
// behind it.
//
// A workspace directory looks like this (everything except story.yaml is optional):
//   story.yaml            StorySpec raw YAML (text)
//   meta.json             storyRow equivalent, title/logline/cover... (text)
//   media.json            media index, chapterSlug -> { file } (text)
//   content/<chapterSlug>.en.txt       one file = one English plaintext fragment (text)
//   media/<mediaSlug>.<ext>            media asset file (blob)
//
// The above is the complete allowlist -- no compatibility path segment is kept for any
// deleted feature; "never build for legacy data, delete on replacement" is a hard rule of
// this repo, and the workspace format is no exception: a path segment stays out of this
// allowlist the moment no code writes or reads it anymore.
//
// Normalization stance (task decision): rather than cleverly sanitizing paths, strictly
// reject suspicious ones -- this module does no path normalization at all (no resolving
// `.`/`..`, no collapsing repeated slashes); any suspicious shape is fail-closed rejected.

export type PathClassification =
  | { readonly ok: true; readonly kind: "text" | "blob" }
  | { readonly ok: false; readonly reason: string };

/** Fixed set of text file names allowed at the workspace root -- the skeleton files of the
 * workspace directory shape. This is a closed set, not "guess the extension": adding a file
 * name means editing this, not working around it. */
const ROOT_TEXT_FILES: ReadonlySet<string> = new Set([
  "story.yaml",
  "meta.json",
  "media.json",
]);

/** `content/<chapterSlug>.en.txt` -- English is the contest format's only language. */
const CONTENT_FILE_PATTERN = /^content\/[a-z0-9-]+\.en\.txt$/;

/** `media/<mediaSlug>.<ext>` -- mediaSlug is lowercase alphanumerics and hyphens; the
 * extension allowlist is images only: png/jpg/jpeg/webp (this repo's scope is images only). */
const MEDIA_FILE_PATTERN = /^media\/[a-z0-9-]+\.(?:png|jpg|jpeg|webp)$/;

/** Generic "looks suspicious" check -- path traversal, absolute paths, URL schemes,
 * hidden/reserved segments. Returns a rejection-reason string, or undefined if it passes.
 * This layer is independent of allowlist shape, deliberately run before pattern matching so
 * the rejection reason is more precise (not overwritten by the content/media pattern's "not
 * in the allowlist" reason). */
function reservedShapeReason(path: string): string | undefined {
  if (path.length === 0) return "empty path";
  if (path.includes("\0")) return "path contains a null byte";
  if (path.includes("\\")) return "path contains a backslash (\\) -- only / separators are accepted";
  if (path.startsWith("/")) return "absolute paths are not allowed";
  if (/^[A-Za-z]:/.test(path)) return "path contains a drive letter, treated as an absolute path";
  if (path.includes("://")) return "path contains a URL scheme (e.g. file://, content://), not a relative path";

  const segments = path.split("/");
  for (const seg of segments) {
    if (seg.length === 0) return "path contains an empty segment (consecutive / or a leading/trailing /)";
    if (seg === "." || seg === "..") return "path contains . or .. (path traversal)";
    if (seg.startsWith(".")) return `path segment "${seg}" is a hidden file/reserved segment (starts with .)`;
  }
  return undefined;
}

/** The sole classification entry point for a workspace-relative path. Returns
 * `{ ok: true, kind }` when the path falls within the allowlist and we know whether it
 * should be stored as text or blob; otherwise returns `{ ok: false, reason }`, where reason
 * is meant for a human to read (not UI copy). */
export function classifyWorkspacePath(path: string): PathClassification {
  if (typeof path !== "string") return { ok: false, reason: "path must be a string" };

  const reserved = reservedShapeReason(path);
  if (reserved) return { ok: false, reason: reserved };

  if (ROOT_TEXT_FILES.has(path)) return { ok: true, kind: "text" };
  if (CONTENT_FILE_PATTERN.test(path)) return { ok: true, kind: "text" };
  if (MEDIA_FILE_PATTERN.test(path)) return { ok: true, kind: "blob" };

  if (path.startsWith("content/")) {
    return {
      ok: false,
      reason: "content/ only accepts <chapterSlug>.en.txt (chapterSlug=^[a-z0-9-]+$)",
    };
  }
  if (path.startsWith("media/")) {
    return {
      ok: false,
      reason: "media/ only accepts <mediaSlug>.<ext> (mediaSlug=^[a-z0-9-]+$, extension limited to png/jpg/jpeg/webp)",
    };
  }
  return {
    ok: false,
    reason: `path is not in the allowlist (not a known root file name, and not under content/ or media/): "${path}"`,
  };
}
