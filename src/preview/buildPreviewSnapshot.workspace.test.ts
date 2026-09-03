// ./buildPreviewSnapshot.ts's snapshot-assembly rules - pure function
// tests, zero storage. Covers "valid story, branching, endings, missing images, exceeding
// limits" cases, plus the assembly rules' own edge cases (missing content,
// zero nodes, a broken structure, defensive fail-closed branches).
//
// diagnostics is fed the real result of `validate(spec)` wherever possible (not a hand-rolled
// fake diagnostics), so these tests also prove "this fixture spec itself is actually valid" -
// only the defensive branches (theoretically-not-reachable fail-closed checks) deliberately
// feed `diagnostics: []` to bypass validate(), see the "Defensive" section at the end of this
// file.
import { describe, expect, it } from "vitest";
import { validate } from "../contract/validate.ts";
import type { Node, StorySpec } from "../contract/types.ts";
import { PREVIEW_LIMITS } from "./snapshot.ts";
import { buildPreviewSnapshot } from "./buildPreviewSnapshot.ts";

const STORY_SLUG = "demo";
const REVISION = 7;
const TITLE = "Sample Story";

function ref(chapterSlug: string) {
  return { $ref: `content://${STORY_SLUG}/chapters/${chapterSlug}#fragments/text` };
}

function endingNode(chapterSlug: string): Node {
  return { type: "ending", content: ref(chapterSlug), ending: { endingId: `${chapterSlug}-ending`, endingType: "good" } };
}

function baseSpec(nodes: Record<string, Node>, start: string): StorySpec {
  return { specVersion: "storymaker/v1alpha1", kind: "Story", metadata: { slug: STORY_SLUG }, start, nodes };
}

function assertZeroValidationErrors(spec: StorySpec) {
  const errors = validate(spec).filter((d) => d.severity === "error");
  expect(errors, `the fixture spec itself should pass validate(): ${JSON.stringify(errors)}`).toHaveLength(0);
}

describe("buildPreviewSnapshot - a valid story (linear)", () => {
  it("assembles a two-page snapshot with correct text/next/title/revision", () => {
    const spec = baseSpec(
      {
        p1: { content: ref("p1"), next: "p2" },
        p2: endingNode("p2"),
      },
      "p1",
    );
    assertZeroValidationErrors(spec);

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map([
        ["p1", "Page one content"],
        ["p2", "Ending content"],
      ]),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.story.title).toBe(TITLE);
    expect(result.snapshot.story.startPageId).toBe("p1");
    expect(result.snapshot.revision).toBe(REVISION);
    expect(result.snapshot.story.pages).toHaveLength(2);

    const p1 = result.snapshot.story.pages.find((p) => p.id === "p1")!;
    expect(p1.text).toBe("Page one content");
    expect(p1.next).toBe("p2");
    expect(p1.choices).toEqual([]);
    expect(p1.imageId).toBeUndefined();

    const p2 = result.snapshot.story.pages.find((p) => p.id === "p2")!;
    expect(p2.text).toBe("Ending content");
    expect(p2.next).toBeUndefined();
    expect(p2.choices).toEqual([]);
  });
});

describe("buildPreviewSnapshot - branching", () => {
  it("choices map to node.choices's key (the label) and target, with next omitted", () => {
    const spec = baseSpec(
      {
        p1: {
          content: ref("p1"),
          choices: {
            "go-left": { target: "p2" },
            "go-right": { target: "p3" },
          },
        },
        p2: endingNode("p2"),
        p3: endingNode("p3"),
      },
      "p1",
    );
    assertZeroValidationErrors(spec);

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map([
        ["p1", "A fork in the road"],
        ["p2", "Ending A"],
        ["p3", "Ending B"],
      ]),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p1 = result.snapshot.story.pages.find((p) => p.id === "p1")!;
    expect(p1.next).toBeUndefined();
    expect(p1.choices).toHaveLength(2);
    expect(new Set(p1.choices.map((c) => c.label))).toEqual(new Set(["go-left", "go-right"]));
    const left = p1.choices.find((c) => c.label === "go-left")!;
    expect(left.target).toBe("p2");
  });
});

describe("buildPreviewSnapshot - endings", () => {
  it("a page with an empty choices array and next as undefined is an ending page (no extra field check needed)", () => {
    const spec = baseSpec({ p1: endingNode("p1") }, "p1");
    assertZeroValidationErrors(spec);

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map([["p1", "The End"]]),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const page = result.snapshot.story.pages[0]!;
    expect(page.choices).toEqual([]);
    expect(page.next).toBeUndefined();
  });
});

describe("buildPreviewSnapshot - illustrations (present/missing)", () => {
  it("when mediaFiles has a file for this chapterSlug, both imageId and images show up, with mime correctly inferred", () => {
    const spec = baseSpec({ p1: endingNode("p1") }, "p1");

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map([["p1", "A page with an illustration"]]),
      mediaFiles: new Map([["p1", { ext: "png", byteLength: 1234 }]]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const page = result.snapshot.story.pages[0]!;
    expect(page.imageId).toBe("p1");
    expect(result.snapshot.images).toEqual([{ id: "p1", mime: "image/png", byteLength: 1234 }]);
  });

  it("missing image: when mediaFiles has no entry for this chapterSlug, imageId is omitted and images doesn't include it", () => {
    const spec = baseSpec({ p1: endingNode("p1") }, "p1");

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map([["p1", "A page with no illustration"]]),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.story.pages[0]!.imageId).toBeUndefined();
    expect(result.snapshot.images).toEqual([]);
  });
});

describe("buildPreviewSnapshot - missing content", () => {
  it("when a chapterSlug has a content ref but pageContent has no matching key, text falls back to an empty string (not invalid-story)", () => {
    const spec = baseSpec({ p1: endingNode("p1") }, "p1");

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map(),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.story.pages[0]!.text).toBe("");
  });

  it("rejects a node that omits its required content ref", () => {
    const spec = baseSpec({ p1: { type: "ending", ending: { endingId: "p1-ending", endingType: "good" } } as any }, "p1");

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map([["p1", "should never show up on screen"]]),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.snapshot.story.pages[0]!.text).toBe("");
  });
});

describe("buildPreviewSnapshot - an invalid structure", () => {
  it("returns invalid-story when validate() has an error", () => {
    const spec = baseSpec({ p1: { content: ref("p1"), next: "nope" } }, "p1"); // dangling next
    const diagnostics = validate(spec);
    expect(diagnostics.some((d) => d.severity === "error")).toBe(true);

    const result = buildPreviewSnapshot({
      spec,
      diagnostics,
      revision: REVISION,
      title: TITLE,
      pageContent: new Map(),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("error");
  });

  it("choices is array-shaped - the real validate() already blocks it as an error, so it goes through invalid-story instead of assembling array indices into the snapshot as labels", () => {
    const spec = baseSpec(
      {
        p1: { content: ref("p1"), choices: [{ target: "p2" }] as any },
        p2: endingNode("p2"),
      },
      "p1",
    );
    const diagnostics = validate(spec);
    expect(diagnostics.some((d) => d.severity === "error")).toBe(true);

    const result = buildPreviewSnapshot({
      spec,
      diagnostics,
      revision: REVISION,
      title: TITLE,
      pageContent: new Map(),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(false);
  });

  it("returns invalid-story when there are zero nodes (no pages at all to preview)", () => {
    const spec = baseSpec({}, "");

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map(),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("at least one page");
  });
});

describe("buildPreviewSnapshot - defensive fail-closed (bypassing validate(), feeding diagnostics: [])", () => {
  it("fail-closed when start points to a node that doesn't exist", () => {
    const spec = baseSpec({ p1: endingNode("p1") }, "does-not-exist");

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: [],
      revision: REVISION,
      title: TITLE,
      pageContent: new Map(),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("start node");
  });

  it("fail-closed when a choice target points to a node that doesn't exist", () => {
    const spec = baseSpec(
      {
        p1: { content: ref("p1"), choices: { "go-nowhere": { target: "does-not-exist" } } },
      },
      "p1",
    );

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: [],
      revision: REVISION,
      title: TITLE,
      pageContent: new Map(),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("go-nowhere");
  });

  it("fail-closed when next points to a node that doesn't exist (not silently disguised as an ending page)", () => {
    const spec = baseSpec({ p1: { content: ref("p1"), next: "does-not-exist" } }, "p1");

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: [],
      revision: REVISION,
      title: TITLE,
      pageContent: new Map(),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("next");
  });

  it("a non-ending node with choices:{} and no next - doesn't assume diagnostics already blocked it, fail-closed instead of disguising it as an ending page", () => {
    // This deliberately bypasses validate() (diagnostics: []), simulating either "the
    // choices:{} bug in ../contract/validate.ts hasn't been fixed yet" or "the diagnostics the
    // caller passed in is out of sync with this spec" - buildPreviewSnapshot() itself must
    // also guard against this combination, and can't rely on the upstream validate() as the
    // one and only gate (see the fail-closed check inside the loop in
    // ./buildPreviewSnapshot.ts).
    const spec = baseSpec({ p1: { content: ref("p1"), choices: {} } }, "p1");

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: [],
      revision: REVISION,
      title: TITLE,
      pageContent: new Map([["p1", "a page that isn't wired up yet"]]),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("ending");
  });
});

describe("buildPreviewSnapshot - exceeding limits (PREVIEW_LIMITS, one by one)", () => {
  it("maxPages: exceeding the page count limit", () => {
    const nodes: Record<string, Node> = {};
    for (let i = 1; i <= PREVIEW_LIMITS.maxPages + 1; i++) {
      const id = `n${i}`;
      nodes[id] = endingNode(id);
    }
    const spec = baseSpec(nodes, "n1");
    assertZeroValidationErrors(spec); // An unreachable node only triggers a warning (unreachable), not an error

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map(),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("page count");
  });

  it("maxTextCharsPerPage: one page's content exceeds the character-count limit", () => {
    const spec = baseSpec({ p1: endingNode("p1") }, "p1");
    const longText = "x".repeat(PREVIEW_LIMITS.maxTextCharsPerPage + 1);

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map([["p1", longText]]),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("content length");
  });

  it("maxChoicesPerPage: one page's choice count exceeds the limit", () => {
    const nodes: Record<string, Node> = {};
    const choices: Record<string, { target: string }> = {};
    for (let i = 1; i <= PREVIEW_LIMITS.maxChoicesPerPage + 1; i++) {
      const id = `target${i}`;
      nodes[id] = endingNode(id);
      choices[`choice-${i}`] = { target: id };
    }
    nodes.p1 = { content: ref("p1"), choices };
    const spec = baseSpec(nodes, "p1");
    assertZeroValidationErrors(spec);

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map(),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("choice count");
  });

  it("maxLabelChars: a choice's label (key) length exceeds the limit", () => {
    const longKey = "x".repeat(PREVIEW_LIMITS.maxLabelChars + 1);
    const spec = baseSpec(
      {
        p1: { content: ref("p1"), choices: { [longKey]: { target: "p2" } } },
        p2: endingNode("p2"),
      },
      "p1",
    );
    assertZeroValidationErrors(spec);

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map(),
      mediaFiles: new Map(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("label length");
  });

  it("maxImageBytes: one illustration exceeds the per-file size limit", () => {
    const spec = baseSpec({ p1: endingNode("p1") }, "p1");

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map(),
      mediaFiles: new Map([["p1", { ext: "png", byteLength: PREVIEW_LIMITS.maxImageBytes + 1 }]]),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("illustration size");
  });

  it("maxTotalImageBytes: each individual image is within the limit, but their sum exceeds it", () => {
    const perImageBytes = Math.floor(PREVIEW_LIMITS.maxImageBytes * 0.9); // valid individually, but the sum will exceed maxTotalImageBytes
    const imageCount = Math.ceil(PREVIEW_LIMITS.maxTotalImageBytes / perImageBytes) + 1;

    const nodes: Record<string, Node> = {};
    const mediaFiles = new Map<string, { ext: string; byteLength: number }>();
    for (let i = 1; i <= imageCount; i++) {
      const id = `n${i}`;
      nodes[id] = endingNode(id);
      mediaFiles.set(id, { ext: "png", byteLength: perImageBytes });
    }
    const spec = baseSpec(nodes, "n1");
    assertZeroValidationErrors(spec);

    const result = buildPreviewSnapshot({
      spec,
      diagnostics: validate(spec),
      revision: REVISION,
      title: TITLE,
      pageContent: new Map(),
      mediaFiles,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toContain("total illustration size");
  });
});
