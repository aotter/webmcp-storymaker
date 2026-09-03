// The coordinate layer -- hands the nodes/edges computed by ./model.ts to
// `@dagrejs/dagre` for automatic layout, computing each card's coordinates and each edge's
// routing points. **Pure function**: the same set of nodes/edges, called at any time, produces
// the same set of coordinates (dagre's own layout algorithm is deterministic, taking no random
// seed) -- nothing is cached, no state is kept; when the caller (./render.ts) needs to relayout,
// it just calls this whole function again from scratch, with no incremental "where it laid out
// last time" state maintained. Layout is automatic, not draggable, and coordinates are not
// persisted -- there's no user-adjustable layout state to save, and the cost of recomputing once
// is a complete non-issue at this repo's story scale -- a single user manually authoring a story,
// node counts are never going to be in the thousands.
//
// Node order (reading order, decided by ./model.ts's readingOrder()) has no effect on the
// coordinates computed here -- dagre's layout looks at the graph's topology (who connects to whom),
// not the order of the input array; reading order only determines the map cards' on-screen
// sequence (see the header of ./model.ts).
import dagre from "@dagrejs/dagre";
import type { MapEdge, MapNode } from "./model.ts";

/** A fixed card size -- resizing cards is not supported (minimal
 * implementation), and dagre's layout needs a fixed width/height to compute non-overlapping
 * coordinates. */
// The size is the card's real rendered height budget (190 wide; border 3 + padding 20 + 4:3
// thumbnail 125 + gap 8 + title 20 + optional foot row ~22 = ~198). If the card CSS in
// ../ui/style.css changes, update this -- an underestimate makes fit-to-view clip the last row.
export const MAP_NODE_WIDTH = 190;
export const MAP_NODE_HEIGHT = 200;

export interface LayoutBox {
  /** The card's top-left corner coordinate (not dagre's native center-point return value --
   * render.ts positions cards with CSS `left`/`top`, so the conversion to a top-left corner is done
   * once here, so callers don't each need to recompute it). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutPoint {
  readonly x: number;
  readonly y: number;
}

export interface StoryMapLayout {
  /** Looks up a card's coordinates by node id -- every MapNode.id from ./model.ts is guaranteed to
   * have an entry here (every node has already been through `setNode()`). */
  readonly nodeBoxes: ReadonlyMap<string, LayoutBox>;
  /** Looks up dagre's computed routing points by MapEdge.id (not dagre's v/w pair -- the same pair
   * of nodes may have several edges, see the header of ./model.ts), for render.ts to draw an SVG
   * `<path>`. When no routing points can be found (shouldn't happen in theory, since every edge has
   * already been through `setEdge()`), this is an empty array, and the caller falls back to a
   * straight line (see render.ts). */
  readonly edgePoints: ReadonlyMap<string, readonly LayoutPoint[]>;
  /** The whole graph's outer bounding size (dagre's computed graph label width/height) -- render.ts
   * uses this to size the canvas's `<svg>`/container, without needing to rescan every node's
   * coordinates itself to compute a bounding box. */
  readonly width: number;
  readonly height: number;
}

/**
 * Hands ./model.ts's nodes/edges to dagre for layout (`rankdir: "LR"`, explicitly named in the task
 * spec). With zero nodes, returns an empty result directly without ever calling dagre -- dagre's
 * behavior on an empty graph isn't something that needs verifying here, and returning early means
 * the caller (the map screen for an empty story) doesn't need to handle dagre's internal edge cases.
 */
export function layoutStoryMap(nodes: readonly MapNode[], edges: readonly MapEdge[]): StoryMapLayout {
  if (nodes.length === 0) {
    return { nodeBoxes: new Map(), edgePoints: new Map(), width: 0, height: 0 };
  }

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 180, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, { width: MAP_NODE_WIDTH, height: MAP_NODE_HEIGHT });
  }
  for (const edge of edges) {
    // The `name` parameter (the fourth one) is what the multigraph uses to distinguish multiple
    // edges between the same pair of nodes -- this uses MapEdge.id directly (the one stable edge
    // identifier), and the routing-point lookup below queries by that same id, so
    // there's no need to maintain a separate id <-> dagre-edge lookup table.
    g.setEdge(edge.from, edge.to, {}, edge.id);
  }

  dagre.layout(g);

  const nodeBoxes = new Map<string, LayoutBox>();
  for (const node of nodes) {
    const box = g.node(node.id);
    // Defensive: every node has already been through setNode(), so in theory it should always be
    // found after dagre.layout() -- rather than assuming a third-party library's internal behavior
    // always matches its documentation, this just skips it if not found (this card ends up as
    // undefined from render.ts's ReadonlyMap.get(), and the render layer decides its own fallback,
    // rather than fabricating coordinates here).
    if (!box || box.x === undefined || box.y === undefined) continue;
    nodeBoxes.set(node.id, { x: box.x - box.width / 2, y: box.y - box.height / 2, width: box.width, height: box.height });
  }

  const edgePoints = new Map<string, readonly LayoutPoint[]>();
  for (const edge of edges) {
    const label = g.edge(edge.from, edge.to, edge.id);
    edgePoints.set(edge.id, label?.points ?? []);
  }

  const graphLabel = g.graph();
  return {
    nodeBoxes,
    edgePoints,
    width: graphLabel?.width ?? 0,
    height: graphLabel?.height ?? 0,
  };
}
