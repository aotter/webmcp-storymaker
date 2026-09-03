import { describe, expect, it } from "vitest";
import type { WorkspaceEntry } from "../workspace/types.ts";
import { listChapterLangs, resolveChapterLang } from "./chapterLang.ts";

const entry = (path: string): WorkspaceEntry => ({ path, kind: "text", byteLength: 1 });

describe("English-only chapter files", () => {
  it("recognizes only an English fragment", () => {
    expect(listChapterLangs([entry("content/page-01.en.txt"), entry("content/page-01.fr.txt")], "page-01")).toEqual(["en"]);
  });
  it("always resolves to English", () => {
    expect(resolveChapterLang([entry("content/page-01.fr.txt")], "page-01", "fr")).toBe("en");
  });
});
