// ./layout.ts's dagre wrapper -- pure-function unit tests that only
// verify "this is a deterministic coordinate calculation" and "the output shape matches what
// render.ts expects", not the quality of dagre's own layout algorithm (that's dagre's own
// responsibility and existing test coverage).
import { describe, expect, it } from "vitest";
import type { MapEdge, MapNode } from "./model.ts";
import { MAP_NODE_HEIGHT, MAP_NODE_WIDTH, layoutStoryMap } from "./layout.ts";

function node(id: string): MapNode {
  return {
    id,
    chapterSlug: id,
    title: id,
    isStart: false,
    isEnding: false,
    textStatus: "ok",
    mediaStatus: "ok",
    hasGap: false,
  };
}

function edge(id: string, from: string, to: string, label: string | null = null): MapEdge {
  return { id, from, to, label };
}

describe("layoutStoryMap", () => {
  it("returns empty maps and zero dimensions for an empty story (no dagre call needed)", () => {
    const layout = layoutStoryMap([], []);
    expect(layout.nodeBoxes.size).toBe(0);
    expect(layout.edgePoints.size).toBe(0);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });

  it("places a single node at its fixed card size", () => {
    const layout = layoutStoryMap([node("a")], []);
    const box = layout.nodeBoxes.get("a");
    expect(box).toBeDefined();
    expect(box!.width).toBe(MAP_NODE_WIDTH);
    expect(box!.height).toBe(MAP_NODE_HEIGHT);
    expect(Number.isFinite(box!.x)).toBe(true);
    expect(Number.isFinite(box!.y)).toBe(true);
  });

  it("lays out left-to-right (rankdir LR): a node's successor sits strictly to its right", () => {
    const layout = layoutStoryMap([node("a"), node("b")], [edge("a>b#next", "a", "b")]);
    const a = layout.nodeBoxes.get("a")!;
    const b = layout.nodeBoxes.get("b")!;
    expect(a.x).toBeLessThan(b.x);
  });

  it("keeps two branch edges between the same node pair distinct, keyed by MapEdge.id", () => {
    const nodes = [node("a"), node("b")];
    const edges = [edge("a>b#left", "a", "b", "left"), edge("a>b#right", "a", "b", "right")];
    const layout = layoutStoryMap(nodes, edges);
    expect(layout.edgePoints.has("a>b#left")).toBe(true);
    expect(layout.edgePoints.has("a>b#right")).toBe(true);
  });

  it("is deterministic: the same nodes/edges produce identical coordinates on repeated calls", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("a>b#next", "a", "b"), edge("b>c#next", "b", "c")];
    const first = layoutStoryMap(nodes, edges);
    const second = layoutStoryMap(nodes, edges);
    expect([...first.nodeBoxes.entries()]).toEqual([...second.nodeBoxes.entries()]);
    expect(first.width).toBe(second.width);
    expect(first.height).toBe(second.height);
  });

  it("does not blow up on an isolated node with no edges", () => {
    const layout = layoutStoryMap([node("solo")], []);
    expect(layout.nodeBoxes.has("solo")).toBe(true);
  });
});
