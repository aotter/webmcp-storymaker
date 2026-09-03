// Shared types for the browser story-operations layer. This is the first
// layer above the workspace virtual file tree (../ports.ts's WorkspaceStoragePort,
// ../workspace/**) that "understands StorySpec semantics" — the workspace layer only
// knows path -> text/blob, it has no idea what's inside story.yaml. This layer is
// responsible for yaml parse/stringify, calling story-contract's validate(), and
// deciding whether a given chapterSlug is actually in use by this story.
//
// Every operation function returns a discriminated union (modeled on the
// WorkspaceMutationResult/WorkspaceMutationError style in ../workspace/types.ts —
// no throwing) — the caller (the future WebMCP tool surface / UI, a later Phase)
// narrows on the `ok` field, and `error.type` decides what message to show. No
// try/catch is needed to handle "this operation didn't succeed."
//
// The sole authority for StorySpec types/validation logic is ../contract/ (see that
// directory's header) — this file only imports the two browser-safe modules ./types
// and ./validate. It never redefines or copies any type or validation rule from the
// contract layer.
import type { Diagnostic, StorySpec } from "../contract/types.ts";
import type { WorkspaceMutationError } from "../workspace/types.ts";

/** The node id / content chapterSlug fixed for creating a minimal story — a single
 * node that is both the start and an ending, the smallest non-zero-node story that
 * passes story-contract validate() (see the createMinimalStory.ts header for
 * details). Not exposed as an input parameter: input
 * only takes minimal parameters like slug/title — naming the node/chapterSlug is an
 * internal decision of this function, not something the caller needs to worry
 * about. */
export const MINIMAL_STORY_NODE_ID = "page-01";

/** Default language code for content/<chapterSlug>.<lang>.txt — this repo doesn't
 * build a language-selection UI (a scope decision), so it's fixed to en. */
export const DEFAULT_LANG = "en";

export type CreateMinimalStoryError =
  | { readonly type: "workspace-not-empty"; readonly entryCount: number }
  | { readonly type: "invalid-input"; readonly field: "slug" | "title"; readonly reason: string }
  | { readonly type: "invalid-story-spec"; readonly diagnostics: readonly Diagnostic[] }
  | { readonly type: "mutation-rejected"; readonly error: WorkspaceMutationError };

export type CreateMinimalStoryResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly error: CreateMinimalStoryError };

export type ReadStoryError =
  | { readonly type: "story-not-found" }
  | { readonly type: "invalid-yaml"; readonly reason: string }
  // review fix (P1): reading story.yaml's content (readFile) and the workspace
  // revision (list()) are two separate storage calls, and a concurrent mutate()
  // can slip in between them, producing a combination like "old spec + new
  // revision" that never actually existed. readStory() was therefore changed to an
  // optimistic retry (see snapshotsMatch/CONSISTENT_READ_MAX_ATTEMPTS in
  // ../workspace/snapshot.ts — the same mechanism is also used by
  // ../story/readiness.ts and ../media/setPageImage.ts); once retries are
  // exhausted without getting a consistent snapshot, this error is returned
  // instead of pretending a clean version was read.
  | { readonly type: "workspace-busy"; readonly reason: string };

export type ReadStoryResult =
  | {
      readonly ok: true;
      readonly revision: number;
      readonly spec: StorySpec;
      readonly diagnostics: readonly Diagnostic[];
    }
  | { readonly ok: false; readonly error: ReadStoryError };

export type UpdateStoryStructureError =
  | { readonly type: "invalid-story-spec"; readonly diagnostics: readonly Diagnostic[] }
  | { readonly type: "mutation-rejected"; readonly error: WorkspaceMutationError };

export type UpdateStoryStructureResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly error: UpdateStoryStructureError };

export type UpdatePageTextError =
  // readStory()'s errors pass through as-is (story-not-found/invalid-yaml/
  // workspace-busy) — updatePageText internally uses readStory() to read the
  // current spec and validate chapterSlug, so a read failure has the same
  // semantics as calling readStory() directly and isn't re-wrapped.
  | ReadStoryError
  | { readonly type: "chapter-not-found"; readonly chapterSlug: string; readonly knownChapterSlugs: readonly string[] }
  | { readonly type: "invalid-text"; readonly reason: string }
  | { readonly type: "invalid-path"; readonly path: string; readonly reason: string }
  | { readonly type: "mutation-rejected"; readonly error: WorkspaceMutationError };

export type UpdatePageTextResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly error: UpdatePageTextError };
