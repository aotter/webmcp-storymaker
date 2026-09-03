// Scan a StorySpec for "which chapterSlugs are currently referenced by
// a content:// ref" — used by updatePageText to decide whether the caller-supplied
// chapterSlug is a page that story.yaml genuinely has in use, not a made-up path
// (chapterSlug must exist among the current story.yaml's nodes).
//
// Every contest node has exactly one content ref, so this module only examines
// node.content. The ref scheme itself is part of docs/STORYSPEC.md's public grammar.
import type { StorySpec } from "../contract/types.ts";
import { parseContentRef } from "../contract/contentRef.ts";

function isRefShape(value: unknown): value is { $ref: string } {
  return typeof value === "object" && value !== null && typeof (value as { $ref?: unknown }).$ref === "string";
}

/** The full set of chapterSlugs referenced by the contest nodes. */
export function collectReferencedChapterSlugs(spec: StorySpec): Set<string> {
  const out = new Set<string>();
  for (const node of Object.values(spec.nodes)) {
    const chapterSlug = chapterSlugFromRef(node.content);
    if (chapterSlug) out.add(chapterSlug);
  }
  return out;
}

/** The single-value counterpart — "which chapterSlug does
 * this one Ref value itself point to," unlike collectReferencedChapterSlugs()'s
 * "which chapterSlugs are referenced across the whole spec / under this whole
 * node" set. `src/map/model.ts` needs to answer the single-value question "which
 * chapterSlug does this node's own content field correspond to (and therefore
 * which content/<chapterSlug>.<lang>.txt fragment — i.e. which page openChapter()
 * should open)" — this reuses the canonical contract parser (no second criterion is
 * redefined); if the value isn't a Ref shape, or its scheme isn't a chapters/text
 * fragment, it always returns undefined (this node has no editable body-text
 * mapping, and the map renders it as "missing"). */
export function chapterSlugFromRef(ref: unknown): string | undefined {
  if (!isRefShape(ref)) return undefined;
  return parseContentRef(ref.$ref)?.chapterSlug;
}
