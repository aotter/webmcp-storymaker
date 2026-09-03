import type { WorkspaceEntry } from "../workspace/types.ts";

/** StoryMaker is English-only; these helpers remain for the read-side callers. */
export function listChapterLangs(entries: readonly WorkspaceEntry[], chapterSlug: string): readonly string[] {
  return entries.some((entry) => entry.path === `content/${chapterSlug}.en.txt`) ? ["en"] : [];
}

export function resolveChapterLang(_entries: readonly WorkspaceEntry[], _chapterSlug: string, _fallbackLang: string): "en" {
  return "en";
}
