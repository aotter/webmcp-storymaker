// Create a minimal StorySpec that fully passes story-contract validate
// from an empty workspace — the first entry point of docs/architecture.md's "single
// story workspace" at the story-operations layer.
//
// Minimal shape (a task decision, written here for future reference): a single node
// that is both the start and an ending — the only hard requirement
// story-contract's validate() (packages/story-contract/src/validate.ts) places on
// an ending node is "must not have next/choices," so a second node isn't needed to
// pass validation. This is the smallest non-zero-node story that passes validate(),
// and it doesn't stuff in any field that isn't required.
//
// The content fragment's initial text uses the caller-supplied title directly, not
// an empty string — the data layer doesn't write placeholder copy,
// so we don't invent a fake "(content pending)" line. Using the title as the initial
// body text is "real content the caller provided," not a made-up placeholder
// string, and it can be overwritten with the real body text at any time via
// updatePageText.
import { stringify as stringifyYaml } from "yaml";
import { validate } from "../contract/validate.ts";
import type { StorySpec } from "../contract/types.ts";
import type { WorkspaceStoragePort } from "../ports.ts";
import type { WorkspaceWriteOp } from "../workspace/types.ts";
import { DEFAULT_LANG, MINIMAL_STORY_NODE_ID, type CreateMinimalStoryResult } from "./types.ts";

// This repo's scope doesn't include a language-selection UI (see the task scope
// decision) — the first-page fragment is fixed to DEFAULT_LANG ("en"). The path
// shape content/<chapterSlug>.<lang>.txt is itself a format contract owned by
// ../workspace/paths.ts, invisible to the user, and doesn't change just because
// language selection was dropped.

// Mirrors story-contract validate.ts's metadata.slug rule (SLUG_RE) — this doesn't
// import that file's internal, unexported constant. This layer validates the input
// shape itself; the real authority remains validate() itself once this passes
// (buildMinimalSpec below is always followed by a real validate() run).
const SLUG_RE = /^[a-z0-9-]+$/;

export interface CreateMinimalStoryInput {
  readonly slug: string;
  readonly title: string;
}

function buildMinimalSpec(input: { readonly slug: string; readonly title: string }): StorySpec {
  return {
    specVersion: "storymaker/v1alpha1",
    kind: "Story",
    // The reader title belongs only in meta.json, not in the closed structure.
    metadata: { slug: input.slug },
    start: MINIMAL_STORY_NODE_ID,
    nodes: {
      [MINIMAL_STORY_NODE_ID]: {
        type: "ending",
        content: { $ref: `content://${input.slug}/chapters/${MINIMAL_STORY_NODE_ID}#fragments/text` },
        ending: { endingId: `${MINIMAL_STORY_NODE_ID}-ending`, endingType: "good" },
      },
    },
  };
}

export async function createMinimalStory(
  storage: WorkspaceStoragePort,
  input: CreateMinimalStoryInput,
): Promise<CreateMinimalStoryResult> {
  const slug = input.slug;
  const title = input.title.trim();
  const lang = DEFAULT_LANG;

  if (!SLUG_RE.test(slug)) {
    return {
      ok: false,
      error: { type: "invalid-input", field: "slug", reason: `slug must match ^[a-z0-9-]+$, got ${JSON.stringify(input.slug)}` },
    };
  }
  if (title.length === 0) {
    return { ok: false, error: { type: "invalid-input", field: "title", reason: "title must not be blank" } };
  }

  // docs/architecture.md's "single story workspace": reject if the workspace is
  // non-empty — this checks "does the workspace have any files at all," not "does
  // it have a story.yaml." Reason: a workspace that is non-empty but has no
  // story.yaml (e.g. media/ files were manually dropped in but no story has been
  // created yet) is still not an "empty workspace" and must not be silently
  // overwritten.
  const snapshot = await storage.list();
  if (snapshot.entries.length > 0) {
    return { ok: false, error: { type: "workspace-not-empty", entryCount: snapshot.entries.length } };
  }

  const spec = buildMinimalSpec({ slug, title });
  const errors = validate(spec).filter((d) => d.severity === "error");
  if (errors.length > 0) {
    // Should never happen (this function builds the spec itself) — defensive
    // fail-closed, not assuming this always gets story-contract's grammar right;
    // better to stop it here than to write a story that fails validate() into the
    // workspace.
    return { ok: false, error: { type: "invalid-story-spec", diagnostics: errors } };
  }

  const storyYamlText = stringifyYaml(spec);
  const metaJsonText = `${JSON.stringify({ title }, null, 2)}\n`;
  const chapterPath = `content/${MINIMAL_STORY_NODE_ID}.${lang}.txt`;

  const ops: WorkspaceWriteOp[] = [
    { op: "write", path: "story.yaml", kind: "text", text: storyYamlText },
    { op: "write", path: "meta.json", kind: "text", text: metaJsonText },
    { op: "write", path: chapterPath, kind: "text", text: title },
  ];

  const result = await storage.mutate({ expectedRevision: snapshot.revision, ops });
  if (!result.ok) {
    return { ok: false, error: { type: "mutation-rejected", error: result.error } };
  }
  return { ok: true, revision: result.revision };
}
