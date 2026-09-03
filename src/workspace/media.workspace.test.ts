import { describe, expect, it } from "vitest";
import { findBrokenMediaReferences, parseMediaJson } from "./media.ts";

describe("closed media.json", () => {
  const chapters = new Set(["page-01"]);

  it("accepts one file for an existing chapter", () => {
    expect(parseMediaJson('{"page-01":{"file":"page-01.png"}}', chapters)).toEqual({ ok: true, value: { "page-01": { file: "page-01.png" } } });
  });

  it.each([
    '{"page-01":{"file":"page-01.png","kind":"image"}}',
    '{"page-01":{"file":"other.png"}}',
    '{"page_01":{"file":"page_01.png"}}',
    '{"unused":{"file":"unused.png"}}',
    '{"page-01":{"file":"page-01.gif"}}',
  ])("rejects media entry outside the closed contract", (text) => {
    expect(parseMediaJson(text, chapters).ok).toBe(false);
  });

  it("reports a validated missing illustration file", () => {
    const parsed = parseMediaJson('{"page-01":{"file":"page-01.webp"}}', chapters);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(findBrokenMediaReferences(parsed.value, new Set())).toEqual(["media/page-01.webp"]);
  });
});
