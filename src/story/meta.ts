// Parsing `meta.json`'s book title — pulled out into its own
// small file because this criterion ("what does `meta.json`'s `title` field have
// to look like to count") previously lived in exactly one place:
// `../webmcp/tools/readonlyTools.ts` (a private, unexported function internal to
// `inspect_story`). The map's top bar also needs the answer to the same
// question ("top bar = story title"), and rather than copying
// the criterion a second time into `../ui/controller.ts`, it's pulled up to the
// `story/` layer (a neutral layer that understands workspace semantics but knows
// nothing about what WebMCP/the DOM look like — the same layering already used by
// `./readStory.ts`/`./readiness.ts`), so both callers share one definition.
// `readonlyTools.ts` was therefore changed to call this instead,
// removing its own former private copy, with behavior completely unchanged.
export function parseMetaTitle(metaJsonText: string | undefined): string | undefined {
  if (metaJsonText === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(metaJsonText);
    if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).title === "string") {
      return (parsed as Record<string, unknown>).title as string;
    }
    return undefined;
  } catch {
    // meta.json's syntax itself is invalid — shouldn't happen in theory (the
    // browser side's single write entry point always validates it's legal JSON
    // before committing), defensively not throwing; the title is just "not
    // found" here, and it doesn't affect any of the caller's other fields.
    return undefined;
  }
}
