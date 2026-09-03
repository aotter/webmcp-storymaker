// Direct unit tests for classifyWorkspacePath -- more exhaustively covering
// path-shape edge cases than contract.ts's round-trip/rejection cases do (URL schemes,
// drive letters, double slashes, casing, a missing lang segment, ...), because this pure
// function is the single source of truth for the whole allowlist and deserves more direct,
// denser testing than testing it indirectly through a port.
import { describe, expect, it } from "vitest";
import { classifyWorkspacePath } from "./paths.ts";

describe("classifyWorkspacePath", () => {
  it("accepts known root text files", () => {
    for (const p of ["story.yaml", "meta.json", "media.json"]) {
      expect(classifyWorkspacePath(p)).toEqual({ ok: true, kind: "text" });
    }
  });

  it("accepts English-only content/<chapterSlug>.en.txt", () => {
    expect(classifyWorkspacePath("content/swim-label.en.txt")).toEqual({ ok: true, kind: "text" });
    expect(classifyWorkspacePath("content/a.en.txt")).toEqual({ ok: true, kind: "text" });
  });

  it("accepts media/<mediaSlug>.<ext> for each allowed extension", () => {
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      expect(classifyWorkspacePath(`media/cover.${ext}`)).toEqual({ ok: true, kind: "blob" });
    }
  });

  it("rejects path traversal in various shapes", () => {
    for (const p of ["../story.yaml", "content/../story.yaml", "a/../../b.txt", "..", "content/../../story.yaml"]) {
      expect(classifyWorkspacePath(p).ok).toBe(false);
    }
  });

  it("rejects absolute paths and drive letters", () => {
    for (const p of ["/story.yaml", "C:\\story.yaml", "C:/story.yaml"]) {
      expect(classifyWorkspacePath(p).ok).toBe(false);
    }
  });

  it("rejects backslashes", () => {
    expect(classifyWorkspacePath("content\\page-01.zh.txt").ok).toBe(false);
  });

  it("rejects URL schemes (must not be confused with content://media:// refs)", () => {
    for (const p of ["file://story.yaml", "content://slug/meta#title", "media://slug/assets/cover"]) {
      expect(classifyWorkspacePath(p).ok).toBe(false);
    }
  });

  it("rejects empty segments (double slash, trailing slash)", () => {
    for (const p of ["content//page.zh.txt", "media/cover.png/", "content/page.zh.txt/", "/"]) {
      expect(classifyWorkspacePath(p).ok).toBe(false);
    }
  });

  it("rejects hidden/reserved segments", () => {
    for (const p of [".env", "content/.hidden.zh.txt", ".git/config", "media/.cover.png"]) {
      expect(classifyWorkspacePath(p).ok).toBe(false);
    }
  });

  it("rejects unknown extensions and malformed content/media shapes", () => {
    expect(classifyWorkspacePath("media/cover.gif").ok).toBe(false);
    // scope proof: images only, no audio -- .mp3 is not in the extension allowlist.
    expect(classifyWorkspacePath("media/voice.mp3").ok).toBe(false);
    expect(classifyWorkspacePath("media/cover").ok).toBe(false);
    expect(classifyWorkspacePath("content/page-01.txt").ok).toBe(false);
    expect(classifyWorkspacePath("content/PAGE-01.en.txt").ok).toBe(false);
    expect(classifyWorkspacePath("content/page-01.zh.txt").ok).toBe(false);
    expect(classifyWorkspacePath("content/page_01.en.txt").ok).toBe(false);
  });

  it("rejects unlisted root file names, including near-misses of the allowlist", () => {
    expect(classifyWorkspacePath("arbitrary.json").ok).toBe(false);
    expect(classifyWorkspacePath("story.yml").ok).toBe(false); // wrong extension
    expect(classifyWorkspacePath("notes.txt").ok).toBe(false); // not a root allowlist file name
    expect(classifyWorkspacePath("Story.yaml").ok).toBe(false); // wrong casing
    expect(classifyWorkspacePath("characters.json").ok).toBe(false);
    expect(classifyWorkspacePath("locations.json").ok).toBe(false);
    expect(classifyWorkspacePath("items.json").ok).toBe(false);
  });

  it("rejects an empty string and non-string input", () => {
    expect(classifyWorkspacePath("").ok).toBe(false);
    // @ts-expect-error deliberately feeding a non-string to verify the runtime guard (a
    // caller's type can be bypassed)
    expect(classifyWorkspacePath(null).ok).toBe(false);
  });
});
