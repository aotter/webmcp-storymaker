// The browser story-operations layer (the first layer above the workspace virtual
// file tree that understands StorySpec semantics) — the sole export point to the
// outside. The WebMCP tool surface / story UI only import from
// here, never touching individual files directly.
//
// `./refs.ts` is re-exported here for the UI layer (src/ui/): the pure function
// "which chapterSlugs does story.yaml currently reference" (used to draw the
// "open a page" list) — refs.ts itself is also used internally by
// updatePageText.ts/readiness.ts/focus.ts.
//
// `./chapterLang.ts` is the authoritative decision
// for "which language should this chapterSlug use right now" — a pure function,
// see that file's header for details.
export * from "./types.ts";
export * from "./createMinimalStory.ts";
export * from "./readStory.ts";
export * from "./updateStoryStructure.ts";
export * from "./updatePageText.ts";
export * from "./readiness.ts";
export * from "./focus.ts";
export * from "./refs.ts";
export * from "./chapterLang.ts";
export * from "./meta.ts";
