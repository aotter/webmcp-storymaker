import { describe, expect, it } from "vitest";
import type { StorySpec } from "./types.ts";
import { validate } from "./validate.ts";

function validSpec(): StorySpec {
  return {
    specVersion: "storymaker/v1alpha1", kind: "Story", metadata: { slug: "demo" }, start: "start",
    nodes: {
      start: { content: { $ref: "content://demo/chapters/start#fragments/text" }, choices: { Continue: { target: "end" } } },
      end: { type: "ending", content: { $ref: "content://demo/chapters/end#fragments/text" }, ending: { endingId: "end", endingType: "good" } },
    },
  };
}

function errors(spec: unknown): string[] {
  return validate(spec as StorySpec).filter((item) => item.severity === "error").map((item) => item.path);
}

describe("competition StorySpec", () => {
  it("accepts pages, choices, and good endings", () => expect(errors(validSpec())).toEqual([]));

  it.each([
    ["inputs", { score: { type: "integer" } }],
    ["state", { score: { type: "integer", initial: 0 } }],
    ["x-gamified", {}],
    ["outcomes", {}],
  ])("rejects removed top-level field %s", (field, value) => {
    const spec = { ...validSpec(), [field]: value };
    expect(errors(spec)).toContain(`/${field}`);
  });

  it.each(["mainPlot", "cast", "presentation", "effects", "requires", "unavailable", "x-visual"]) ("rejects removed node or choice field %s", (field) => {
    const spec = validSpec() as any;
    if (["effects", "requires", "unavailable"].includes(field)) spec.nodes.start.choices.Continue[field] = {};
    else spec.nodes.start[field] = {};
    expect(errors(spec)).toContain(field.startsWith("x-") ? `/nodes/start/${field}` : field === "effects" || field === "requires" || field === "unavailable" ? `/nodes/start/choices/Continue/${field}` : `/nodes/start/${field}`);
  });

  it("rejects non-good endings and missing required content", () => {
    const badEnding = validSpec() as any;
    badEnding.nodes.end.ending.endingType = "bad";
    expect(errors(badEnding)).toContain("/nodes/end/ending/endingType");
    const missingContent = validSpec() as any;
    delete missingContent.nodes.start.content;
    expect(errors(missingContent)).toContain("/nodes/start/content");
  });

  it("rejects malformed and cross-story content refs", () => {
    const malformed = validSpec() as any;
    malformed.nodes.start.content = { $ref: "nope" };
    expect(errors(malformed)).toContain("/nodes/start/content");
    const mismatched = validSpec() as any;
    mismatched.nodes.start.content = { $ref: "content://other-story/chapters/start#fragments/text" };
    expect(errors(mismatched)).toContain("/nodes/start/content");
  });

  it("rejects an empty node map", () => {
    const empty = { ...validSpec(), start: "", nodes: {} } as any;
    expect(errors(empty)).toContain("/nodes");
  });
});
