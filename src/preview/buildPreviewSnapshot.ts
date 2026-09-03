// A **pure function** from StorySpec + already-read content/image
// file info to a PreviewSnapshot. Zero I/O - the caller (LocalSource in ./localSource.ts, and
// RelaySource, if it needs to assemble a snapshot on the creator's side) is
// responsible for reading the workspace into the shape this function needs; this file only
// cares about "is this content valid, can it be assembled into a snapshot," and knows nothing
// about what IndexedDB/relay look like.
//
// ---------------------------------------------------------------------------
// Snapshot-assembly rules
// ---------------------------------------------------------------------------
// Page id: uses `spec.nodes`'s key directly (not chapterSlug) - `node.next`/`choice.target`
// already point to each other using node ids, so PreviewPage.id/next/choices[].target reuse
// the same set of ids, and PreviewReader therefore doesn't need another "node id <-> chapterSlug"
// lookup layer.
//
// Start page (startPageId): `spec.start`.
//
// Content (text): `chapterSlugFromRef(node.content)` resolves the chapterSlug for this node;
// if no read-out content is found (`pageContent` has no such key - the node has no resolvable
// content ref, or the fragment file for whatever language the caller is currently reading
// doesn't exist yet), it always falls back to an empty string `""`, and this is **not**
// invalid-story: the preview should honestly show the draft state of "this page hasn't been
// written yet" (the same spirit as the "missing item" concept on the creator's map, see the
// ../map/model.ts header - this file deliberately does not import that one, to avoid coupling
// the preview module to the map module, but it follows the same rule).
//
// Illustration (imageId): the same rule - mediaSlug === chapterSlug (the rule from
// ../map/model.ts's header, "the basis for the page <-> art mapping"; restated
// independently here rather than importing that file). The caller only puts an entry in
// `mediaFiles` when the file `media/<chapterSlug>.<ext>` actually exists - so this is a plain
// lookup: not found means no illustration (imageId omitted), not invalid-story.
//
// Choices: the key of the `node.choices` Record is itself the reader label.
//
// next: only appears when `node.choices` is empty and `node.next` exists and points to a real
// node - `../contract/validate.ts` already guarantees "a non-ending node must have next or
// choices, but not both" and "next/choices targets can never dangle," so as long as
// `diagnostics` has no error (the first gate below already rejects stories with an error),
// these conditions always hold; this code still defensively rechecks it anyway (fail-closed,
// never assuming the upstream validation logic is always correct) - not a redundant repeat.
//
// Ending page: `choices` is an empty array and `next` is `undefined` - this follows the
// authoritative definition in the ../preview/snapshot.ts PreviewPage header, "an empty array
// with an empty next -> this is an ending," exactly, with no extra reference to
// `node.type === "ending"` (PreviewPage itself carries no node-type field). In theory
// validate() guarantees this can only happen on a real ending node (a non-ending node is
// required to have next or choices) - but this code does not assume `diagnostics` is
// necessarily "the result of running against this exact spec, with validate() itself bug-free";
// after assembling each page's choices/next, it still rechecks whether "a non-ending node has
// accidentally fallen into this ending criterion" (see the fail-closed check inside the
// loop below) - it doesn't rely solely on the upstream validate() as the one gate.
//
// Page title (PreviewPage.title): this always omits it (`undefined`) -
// chapterSlug is only an internal
// identifier, not a "page title" meant for the reader; showing it directly would leak internal
// naming to the reader (this differs from ../map/model.ts's MapNode.title using chapterSlug as
// "card display text" - that's the creator's own editing screen, this is the reader's reading
// interface).
//
// PREVIEW_LIMITS checks: exceeding any of them -> invalid-story (the single authoritative
// consumer of the "snapshot caps" in the ../preview/snapshot.ts PREVIEW_LIMITS header). A
// story with a validate() error (not counting warnings - a warning only means "some node is
// unreachable," which doesn't affect the safety of preview rendering) is also treated as
// invalid-story: a story carrying an error cannot guarantee that every next/choices target
// actually exists, so it's unsafe to turn it into a snapshot.
import type { Choice, Diagnostic, StorySpec } from "../contract/types.ts";
import { chapterSlugFromRef } from "../story/refs.ts";
import {
  PREVIEW_LIMITS,
  type PreviewChoice,
  type PreviewImageMeta,
  type PreviewImageMime,
  type PreviewPage,
  type PreviewSnapshot,
} from "./snapshot.ts";

/** Info about an approved illustration file - the two fields the caller (./localSource.ts)
 * attaches when it looks up whether `media/<chapterSlug>.<ext>` exists in the workspace
 * entries; enough for this function to decide imageId/mime and run the PREVIEW_LIMITS image
 * size check, without needing to read the image bytes themselves (the bytes are left for
 * PreviewSource.image() to read separately, on demand). */
export interface PreviewMediaFileInfo {
  readonly ext: string;
  readonly byteLength: number;
}

export interface BuildPreviewSnapshotInput {
  readonly spec: StorySpec;
  /** The result of `../story/readStory.ts`'s `validate(spec)` - this function only checks
   * whether the error count is zero (see "PREVIEW_LIMITS checks" in the header); it does not
   * distinguish between the details of individual errors. */
  readonly diagnostics: readonly Diagnostic[];
  readonly revision: number;
  /** The already-resolved story title (meta.json's title, or the caller's own fallback to
   * storySlug) - this function doesn't know, and doesn't need to know, how meta.json gets
   * resolved (that's `../story/meta.ts`'s `parseMetaTitle()`'s job). */
  readonly title: string;
  /** chapterSlug -> the already-read-out content text (the caller decides which language's
   * fragment file to read, see `resolveChapterLang()` in `../story/chapterLang.ts` - this
   * function does no language selection). A missing chapterSlug is treated as "this page has
   * no content yet," see the file header. */
  readonly pageContent: ReadonlyMap<string, string>;
  /** chapterSlug -> info about the matching `media/<chapterSlug>.<ext>` file, present only
   * when that file actually exists - see "Illustration" in the file header. */
  readonly mediaFiles: ReadonlyMap<string, PreviewMediaFileInfo>;
}

export interface BuildPreviewSnapshotError {
  /** A human-readable diagnostic string (may contain technical detail) - for logs/tests only;
   * `./localSource.ts` puts it into the `reason` field (never shown externally) when it
   * converts this into a `PreviewSourceError` - it is not copy meant for the reader (see the
   * `./messages.ts` header). */
  readonly reason: string;
}

export type BuildPreviewSnapshotResult =
  | { readonly ok: true; readonly snapshot: PreviewSnapshot }
  | { readonly ok: false; readonly error: BuildPreviewSnapshotError };

function mimeForExt(ext: string): PreviewImageMime | undefined {
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      // The MEDIA_FILE_PATTERN allowlist in ../workspace/paths.ts only permits these three
      // extensions - in theory this branch should never be reached; fail-closed and return
      // undefined, and the caller treats it as "there's no such image," rather than
      // fabricating some type for a weird extension whose mime can't be looked up.
      return undefined;
  }
}

function invalid(reason: string): BuildPreviewSnapshotResult {
  return { ok: false, error: { reason } };
}

export function buildPreviewSnapshot(input: BuildPreviewSnapshotInput): BuildPreviewSnapshotResult {
  const { spec, diagnostics, revision, title, pageContent, mediaFiles } = input;

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  if (errorCount > 0) {
    const firstError = diagnostics.find((d) => d.severity === "error");
    return invalid(`The story structure has ${errorCount} error(s), so it can't be safely previewed yet${firstError ? ` (for example: ${firstError.path} ${firstError.message})` : ""}.`);
  }

  const nodes = spec.nodes ?? {};
  const nodeEntries = Object.entries(nodes);
  if (nodeEntries.length === 0) {
    return invalid("This story has no pages yet, so it can't be previewed.");
  }
  if (!nodes[spec.start]) {
    // Defensive: when nodes exist, validate() already flags a dangling start as an error (see
    // ../contract/validate.ts), so in theory this branch is unreachable when errorCount === 0
    // - never assume the upstream validation is always correct; fail-closed here.
    return invalid(`The start node "${spec.start}" doesn't exist.`);
  }
  if (nodeEntries.length > PREVIEW_LIMITS.maxPages) {
    return invalid(`The page count ${nodeEntries.length} exceeds the limit of ${PREVIEW_LIMITS.maxPages}.`);
  }

  const pages: PreviewPage[] = [];
  const referencedImageIds = new Set<string>();

  for (const [id, node] of nodeEntries) {
    const chapterSlug = chapterSlugFromRef(node.content);
    const text = chapterSlug !== undefined ? (pageContent.get(chapterSlug) ?? "") : "";
    if (text.length > PREVIEW_LIMITS.maxTextCharsPerPage) {
      return invalid(`Page "${id}"'s content length ${text.length} exceeds the limit of ${PREVIEW_LIMITS.maxTextCharsPerPage}.`);
    }

    let imageId: string | undefined;
    const media = chapterSlug !== undefined ? mediaFiles.get(chapterSlug) : undefined;
    if (media) {
      const mime = mimeForExt(media.ext);
      if (mime !== undefined) {
        if (media.byteLength > PREVIEW_LIMITS.maxImageBytes) {
          return invalid(`Page "${id}"'s illustration size ${media.byteLength} bytes exceeds the per-file limit of ${PREVIEW_LIMITS.maxImageBytes}.`);
        }
        imageId = chapterSlug;
        referencedImageIds.add(chapterSlug!);
      }
    }

    const choiceEntries = Object.entries(node.choices ?? {}) as [string, Choice][];
    if (choiceEntries.length > PREVIEW_LIMITS.maxChoicesPerPage) {
      return invalid(`Page "${id}"'s choice count ${choiceEntries.length} exceeds the limit of ${PREVIEW_LIMITS.maxChoicesPerPage}.`);
    }

    const choices: PreviewChoice[] = [];
    for (const [key, choice] of choiceEntries) {
      // Defensive (see "next/choices" in the file header): when errorCount === 0, validate()
      // already guarantees choice.target exists; this still rechecks it, never assuming the
      // upstream is always correct.
      if (!choice.target || !nodes[choice.target]) {
        return invalid(`Page "${id}"'s choice "${key}" points to a node that doesn't exist: "${choice.target}".`);
      }
      const label = key;
      if (label.length > PREVIEW_LIMITS.maxLabelChars) {
        return invalid(`Page "${id}"'s choice "${key}" has a label length of ${label.length}, exceeding the limit of ${PREVIEW_LIMITS.maxLabelChars}.`);
      }
      choices.push({ label, target: choice.target });
    }

    let next: string | undefined;
    if (choices.length === 0 && node.next !== undefined) {
      // Defensive (same rationale as choices above): when errorCount === 0, validate() already
      // guarantees next always points to a real node - this still rechecks it, and if it's not
      // found, treats the whole thing as invalid-story rather than silently disguising a
      // broken page that "should have a next page but can't reach one" as an ordinary-looking
      // ending page (choices=[] && next=undefined is exactly PreviewPage's ending criterion,
      // see the ../preview/snapshot.ts header).
      if (!nodes[node.next]) {
        return invalid(`Page "${id}"'s next points to a node that doesn't exist: "${node.next}".`);
      }
      next = node.next;
    }

    // Does not assume `diagnostics` already guarantees "a non-ending
    // node always has next or choices" - before `../contract/validate.ts` fixed the bug where
    // an empty `choices: {}` object was misjudged as "has choices" by `!node.choices`, a
    // non-ending node with no next and an empty choices object could pass validation with zero
    // errors; and even if validate() itself is always correct, the `diagnostics` here is still
    // external input passed in by the caller (./localSource.ts), with no guarantee it's really
    // the result of running against this exact `spec` (e.g. the caller passed the wrong one, or
    // versions are out of sync). After computing choices/next for a node, if that node isn't
    // declared as ending yet both are empty, it's a "not wired up yet" broken node - don't let
    // it silently fall into PreviewPage's ending criterion (choices=[] && next=undefined, see
    // the ../preview/snapshot.ts header); treat the whole thing as invalid-story.
    if (node.type !== "ending" && choices.length === 0 && next === undefined) {
      return invalid(`Page "${id}" isn't an ending node, but has no usable next or choices (the story structure may be incomplete).`);
    }

    pages.push({ id, text, imageId, choices, next });
  }

  let totalImageBytes = 0;
  const images: PreviewImageMeta[] = [];
  for (const imageId of referencedImageIds) {
    const media = mediaFiles.get(imageId)!;
    const mime = mimeForExt(media.ext)!; // referencedImageIds is only added to when mimeForExt has a value, see above
    images.push({ id: imageId, mime, byteLength: media.byteLength });
    totalImageBytes += media.byteLength;
  }
  if (totalImageBytes > PREVIEW_LIMITS.maxTotalImageBytes) {
    return invalid(`The total illustration size ${totalImageBytes} bytes exceeds the limit of ${PREVIEW_LIMITS.maxTotalImageBytes}.`);
  }

  return {
    ok: true,
    snapshot: {
      story: { title, startPageId: spec.start, pages },
      images,
      revision,
    },
  };
}
