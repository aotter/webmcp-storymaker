// Pure-function unit tests for
// ./model.ts -- no storage/DOM needed, feeding it pure data fixtures of
// StorySpec/StoryReadiness/a mediaSlugs set directly (same existing style as
// ../story/chapterLang.workspace.test.ts).
import { describe, expect, it } from "vitest";
import type { StorySpec } from "../contract/types.ts";
import type { ReadinessReport, StoryReadiness } from "../story/readiness.ts";
import { computeStoryMap } from "./model.ts";

function contentRef(slug: string, chapterSlug: string) {
  return { $ref: `content://${slug}/chapters/${chapterSlug}#fragments/text` };
}

/** A three-page branching story: start (choices left/right) -> mid-a / mid-b -> neither has any
 * next/choices (not marked ending; `validate()` would in theory flag a warning here, but validate()
 * isn't run in this file -- model.ts itself never validates whether a StorySpec is semantically
 * complete, it only describes "what the known links draw as"). Plus one extra orphan node, with no
 * edge pointing to it and unreachable from start, to verify readingOrder()'s rule of "unreachable
 * nodes still appear, sorted to the end". */
function branchingSpec(): StorySpec {
  return {
    specVersion: "storymaker/v1alpha1",
    kind: "Story",
    metadata: { slug: "demo" },
    start: "start",
    nodes: {
      start: {
        content: contentRef("demo", "start"),
        choices: {
          left: { target: "mid-a" },
          right: { target: "mid-b" },
        },
      },
      "mid-a": { content: contentRef("demo", "mid-a"), type: "ending" },
      "mid-b": { content: contentRef("demo", "mid-b"), type: "ending" },
      orphan: { content: contentRef("demo", "orphan"), type: "ending" },
    },
  };
}

function readyReport(overrides: Partial<ReadinessReport> = {}): ReadinessReport {
  return {
    status: "ready",
    revision: 1,
    diagnostics: { errors: [], warnings: [] },
    content: { totalReferenced: 4, missing: [] },
    media: { missing: [], unparsable: false },
    summary: "The story is complete.",
    ...overrides,
  };
}

const NO_MEDIA: ReadonlySet<string> = new Set();

describe("computeStoryMap — nodes/edges structure", () => {
  it("walks spec.nodes via next/choices in BFS reading order, starting from spec.start", () => {
    const map = computeStoryMap({ spec: branchingSpec(), readiness: null, mediaSlugs: NO_MEDIA });
    // start appears first, mid-a/mid-b follow (in choices's existing key order left->right), and
    // the unreachable orphan is sorted to the end.
    expect(map.nodes.map((n) => n.id)).toEqual(["start", "mid-a", "mid-b", "orphan"]);
  });

  it("builds one edge per choice, labelled with the choice key, plus no edge for dangling targets", () => {
    const spec = branchingSpec();
    spec.nodes["mid-a"] = { ...spec.nodes["mid-a"], next: "nonexistent-node" };
    const map = computeStoryMap({ spec, readiness: null, mediaSlugs: NO_MEDIA });

    expect(map.edges).toEqual([
      { id: "start>mid-a#left", from: "start", to: "mid-a", label: "left" },
      { id: "start>mid-b#right", from: "start", to: "mid-b", label: "right" },
    ]);
  });

  it("gives a linear `next` edge a null label (only branch edges get the choice key)", () => {
    const spec: StorySpec = {
      specVersion: "storymaker/v1alpha1",
      kind: "Story",
      metadata: { slug: "demo" },
      start: "a",
      nodes: {
        a: { content: contentRef("demo", "a"), next: "b" },
        b: { content: contentRef("demo", "b"), type: "ending" },
      },
    };
    const map = computeStoryMap({ spec, readiness: null, mediaSlugs: NO_MEDIA });
    expect(map.edges).toEqual([{ id: "a>b#next", from: "a", to: "b", label: null }]);
  });

  it("marks the node named by spec.start as isStart, and ending nodes as isEnding", () => {
    const map = computeStoryMap({ spec: branchingSpec(), readiness: null, mediaSlugs: NO_MEDIA });
    const byId = new Map(map.nodes.map((n) => [n.id, n]));
    expect(byId.get("start")!.isStart).toBe(true);
    expect(byId.get("mid-a")!.isStart).toBe(false);
    expect(byId.get("mid-a")!.isEnding).toBe(true);
    expect(byId.get("start")!.isEnding).toBe(false);
  });

  it("uses the required content ref to map an ending page", () => {
    const spec: StorySpec = {
      specVersion: "storymaker/v1alpha1",
      kind: "Story",
      metadata: { slug: "demo" },
      start: "no-content",
      nodes: { "no-content": { type: "ending", content: contentRef("demo", "no-content"), ending: { endingId: "no-content", endingType: "good" } } },
    };
    const map = computeStoryMap({ spec, readiness: null, mediaSlugs: NO_MEDIA });
    expect(map.nodes).toEqual([
      {
        id: "no-content",
        chapterSlug: "no-content",
        title: "no-content",
        isStart: true,
        isEnding: true,
        textStatus: "unknown",
        mediaStatus: "missing",
        hasGap: true,
      },
    ]);
  });
});

describe("computeStoryMap — textStatus (mapped from readiness)", () => {
  it("is 'unknown' for every node when readiness has not produced a full report yet (null/not-started/unreadable)", () => {
    const spec = branchingSpec();
    for (const readiness of [null, { status: "not-started", summary: "x" }, { status: "unreadable", reason: { type: "workspace-busy", detail: "x" }, summary: "x" }] satisfies (StoryReadiness | null)[]) {
      const map = computeStoryMap({ spec, readiness, mediaSlugs: NO_MEDIA });
      expect(map.nodes.every((n) => n.textStatus === "unknown")).toBe(true);
    }
  });

  it("marks a chapterSlug 'missing' when readiness.content.missing lists it, and 'ok' otherwise", () => {
    const spec = branchingSpec();
    const readiness = readyReport({ content: { totalReferenced: 4, missing: [{ chapterSlug: "mid-a", reason: "empty" }] } });
    const map = computeStoryMap({ spec, readiness, mediaSlugs: NO_MEDIA });
    const byId = new Map(map.nodes.map((n) => [n.id, n]));
    expect(byId.get("mid-a")!.textStatus).toBe("missing");
    expect(byId.get("start")!.textStatus).toBe("ok");
    expect(byId.get("mid-b")!.textStatus).toBe("ok");
  });
});

describe("computeStoryMap — mediaStatus (mapped from the mediaSlugs set, ignores readiness)", () => {
  it("is 'ok' only when this node's chapterSlug is in the mediaSlugs set", () => {
    const spec = branchingSpec();
    const mediaSlugs = new Set(["start"]);
    const map = computeStoryMap({ spec, readiness: null, mediaSlugs });
    const byId = new Map(map.nodes.map((n) => [n.id, n]));
    expect(byId.get("start")!.mediaStatus).toBe("ok");
    expect(byId.get("mid-a")!.mediaStatus).toBe("missing"); // Not in the set
    expect(byId.get("mid-b")!.mediaStatus).toBe("missing"); // Not in the set
  });

  it("does not depend on readiness at all (media gaps are this module's own convention, not tracked by readiness.ts)", () => {
    const spec = branchingSpec();
    const mediaSlugs = new Set(["start"]);
    const withReport = computeStoryMap({ spec, readiness: readyReport(), mediaSlugs });
    const withoutReport = computeStoryMap({ spec, readiness: null, mediaSlugs });
    expect(withReport.nodes.find((n) => n.id === "start")!.mediaStatus).toBe("ok");
    expect(withoutReport.nodes.find((n) => n.id === "start")!.mediaStatus).toBe("ok");
  });
});

describe("computeStoryMap — hasGap", () => {
  it("is true when either textStatus or mediaStatus is not 'ok'", () => {
    const spec = branchingSpec();
    const readiness = readyReport({ content: { totalReferenced: 4, missing: [] } }); // Text is entirely ok
    const mediaSlugs = new Set(["start"]); // Only start\u2019s art is ok
    const map = computeStoryMap({ spec, readiness, mediaSlugs });
    const byId = new Map(map.nodes.map((n) => [n.id, n]));
    expect(byId.get("start")!.hasGap).toBe(false); // Text ok + art ok
    expect(byId.get("mid-a")!.hasGap).toBe(true); // Text ok, art missing
  });
});

describe("computeStoryMap — counts", () => {
  it("reports textReady/textTotal as null when readiness has no full report yet", () => {
    const map = computeStoryMap({ spec: branchingSpec(), readiness: null, mediaSlugs: NO_MEDIA });
    expect(map.counts.textReady).toBeNull();
    expect(map.counts.textTotal).toBeNull();
  });

  it("mirrors readiness.content exactly for textReady/textTotal (single source of truth, no re-derivation)", () => {
    const readiness = readyReport({ content: { totalReferenced: 4, missing: [{ chapterSlug: "mid-a", reason: "empty" }] } });
    const map = computeStoryMap({ spec: branchingSpec(), readiness, mediaSlugs: NO_MEDIA });
    expect(map.counts.textTotal).toBe(4);
    expect(map.counts.textReady).toBe(3);
  });

  it("counts media readiness over the distinct set of chapterSlugs the map's nodes resolve to", () => {
    const spec = branchingSpec(); // 4 nodes, 4 distinct chapterSlugs (start/mid-a/mid-b/orphan)
    const mediaSlugs = new Set(["start", "mid-a"]);
    const map = computeStoryMap({ spec, readiness: null, mediaSlugs });
    expect(map.counts.mediaTotal).toBe(4);
    expect(map.counts.mediaReady).toBe(2);
  });
});
