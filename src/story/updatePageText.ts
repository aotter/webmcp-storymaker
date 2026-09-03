// Update a single page's text — writes the corresponding
// content/<chapterSlug>.<lang>.txt.
//
// chapterSlug must exist among the current story.yaml's nodes (a nonexistent page
// is rejected) — this is decided by reusing
// readStory() to read the current spec, then using ./refs.ts's
// collectReferencedChapterSlugs to scan out the set of chapterSlugs "currently
// actually referenced"; anything not in that set is rejected (chapter-not-found).
//
// Blank text / over-limit rejection (following the 1.1 cap in
// ../workspace/limits.ts):
//   - Over limit: mutate() (planMutation in ../workspace/mutate.ts) already blocks
//     an over-limit text write with MAX_TEXT_FILE_BYTES (size-exceeded) on its own;
//     this doesn't validate it a second time and just lets mutate()'s error pass
//     through.
//   - Blank: mutate() itself does not forbid an empty text string — that's the
//     read-side stance of "unfilled = a legitimate draft state" (docs/STORYSPEC.md),
//     where reading an empty fragment is only a warning and doesn't block
//     completeness checks. But this "update page text" write API chooses not to let
//     the caller explicitly write a page as blank — this is a deliberate write
//     action (a human or an agent actively calling this API), not the natural
//     residue of a draft, so this layer is deliberately stricter than the
//     workspace layer on blankness. That's a design choice, not a missed
//     validation.
import type { WorkspaceStoragePort } from "../ports.ts";
import { classifyWorkspacePath } from "../workspace/paths.ts";
import { readStory } from "./readStory.ts";
import { collectReferencedChapterSlugs } from "./refs.ts";
import type { UpdatePageTextResult } from "./types.ts";

export interface UpdatePageTextInput {
  readonly expectedRevision: number;
  readonly chapterSlug: string;
  readonly lang: string;
  readonly text: string;
}

export async function updatePageText(
  storage: WorkspaceStoragePort,
  input: UpdatePageTextInput,
): Promise<UpdatePageTextResult> {
  if (input.text.trim().length === 0) {
    return { ok: false, error: { type: "invalid-text", reason: "text must not be blank" } };
  }

  const path = `content/${input.chapterSlug}.${input.lang}.txt`;
  const classification = classifyWorkspacePath(path);
  if (!classification.ok) {
    return { ok: false, error: { type: "invalid-path", path, reason: classification.reason } };
  }

  const current = await readStory(storage);
  if (!current.ok) {
    // ReadStoryError's members (story-not-found/invalid-yaml/workspace-busy) share
    // the same shape as UpdatePageTextError — passed through as-is, not
    // re-wrapped.
    return { ok: false, error: current.error };
  }

  // review fix (P1): the current.revision returned by readStory() (which already
  // has its own optimistic retry against torn reads, see ./readStory.ts) is the
  // workspace version that "the spec used to validate chapterSlug" genuinely
  // corresponds to. If the caller's claimed expectedRevision doesn't match this
  // version, it means the spec the caller is holding is already a different
  // version (not the one it thinks it's updating) — reject directly rather than
  // taking a possibly-stale spec to validate chapterSlug while writing onto a
  // newer revision, which would produce an orphan fragment that "the new version
  // of the story doesn't reference at all." This is reported with the same
  // mutation-rejected + revision-conflict shape as
  // updateStoryStructure()/mutate(), so the caller only needs to recognize one
  // "wrong version" error shape. This check is an early interception, not the
  // only line of defense: the window between readStory() and the mutate() call
  // below can still see a new concurrent write — mutate() itself does the final,
  // truly atomic OCC comparison against the same expectedRevision, which is the
  // last line of defense for this guarantee.
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
    return {
      ok: false,
      error: {
        type: "chapter-not-found",
        chapterSlug: input.chapterSlug,
        knownChapterSlugs: [...knownChapterSlugs].sort(),
      },
    };
  }

  const result = await storage.mutate({
    expectedRevision: input.expectedRevision,
    ops: [{ op: "write", path, kind: "text", text: input.text }],
  });
  if (!result.ok) {
    return { ok: false, error: { type: "mutation-rejected", error: result.error } };
  }
  return { ok: true, revision: result.revision };
}
