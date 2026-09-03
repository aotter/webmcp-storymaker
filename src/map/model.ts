// The map data layer -- a **pure function**
// transformation from "story.yaml + readiness + the current set of chapterSlugs with art" to "the
// nodes/edges/status the map needs to draw". Zero DOM, zero storage, zero async -- this file only
// does data-shape transformation; painting the result onto the screen is ./render.ts's job, and
// deciding coordinates is ./layout.ts's job (a layering decision from the file header).
//
// ---------------------------------------------------------------------------
// A node = which thing in story.yaml?
// ---------------------------------------------------------------------------
// The map's "page cards" correspond to each node in `spec.nodes` (keyed by node id), not the
// chapterSlug set returned by `collectReferencedChapterSlugs()` -- the old sidebar list (the
// already-deleted renderChapterList in ../ui/dom.ts) only needed "which chapterSlugs can be
// selected to edit text", and didn't need to know how nodes connect to each other; the map needs the
// real story flow graph (who leads to whom, how choices branch), so it switches to going straight
// through `spec.nodes` instead -- that's the only place in a StorySpec that records both "who the
// nodes are" and "how they connect" (`next`/`choices[].target`) at once.
//
// The "which chapterSlug does this card's text map to" shown on each node card is extracted from
// that node's own `content` field (`chapterSlugFromRef()`, newly added to `../story/refs.ts`,
// reusing the existing CHAPTER_REF_RE criterion rather than inventing a second set of rules) -- if a
// node's `content` isn't shaped like `{ $ref: "content://.../chapters/<slug>#fragments/text" }`
// (missing fields, or pointing at a different scheme), that node has no editable text mapping at
// all, and the map draws it as a "gap" (textStatus: "unknown", a dashed card border), rather than
// guessing at a chapterSlug.
//
// ---------------------------------------------------------------------------
// Status-derivation rules
// ---------------------------------------------------------------------------
// textStatus:
//   - "unknown": the node has no resolvable chapterSlug (see above), or readiness hasn't read a full
//     report yet (loading/not-started/unreadable -- in these states readiness.content simply doesn't
//     exist, so there's no way to tell whether this page has text; this honestly reports "unknown"
//     rather than guessing a default).
//   - "missing": readiness is a full report (ReadinessReport), and this chapterSlug appears in
//     `readiness.content.missing` (a missing or empty file -- from the map's perspective both mean
//     "this page has no text yet"; no finer distinction is drawn here, that's left to the right
//     column's readiness summary text, which already lists the specific reason).
//   - "ok": readiness is a full report, and this chapterSlug isn't in the missing list.
//   This rule entirely reuses the `content.missing` already computed by `../story/readiness.ts`,
//   rather than re-scanning the workspace's files here -- avoiding the map and the right column's
//   "text N/M" count from computing two inconsistent answers (the two are meant to be two
//   presentations of the exact same number).
//
// mediaStatus:
//   - "unknown": the node has no resolvable chapterSlug -- with no chapterSlug there's no mediaSlug
//     under the rule below either (see "the basis for the page <-> art mapping" below), so
//     there's nothing to judge from.
//   - "ok": the `mediaSlugs` set contains this chapterSlug -- `mediaSlugs` is a set the caller
//     (../ui/controller.ts's hydrate()) computes by scanning the workspace's file list once for
//     `media/<slug>.<ext>` (when the agent writes via `set_page_image`, it writes exactly this file,
//     with no manual-approval step in between, see the header of ../media/setPageImage.ts) -- it's
//     simply "does that file exist right now".
//   - "missing": has a chapterSlug, but it's not in the `mediaSlugs` set.
//
// hasGap (the card's dashed border): textStatus !== "ok" || mediaStatus !== "ok" (both counting
// "unknown" as a gap too -- having no chapterSlug to map to is itself a structural gap the author
// needs to address, not something to shrug off just because it's unknown).
//
// ---------------------------------------------------------------------------
// The basis for the page <-> art mapping (still in force):
// the rule "chapterSlug determines the filename"
// ---------------------------------------------------------------------------
// The closed StoryMaker contract intentionally has no per-node media filename field. The
// mapping is therefore defined once here, rather than inferred from optional story data.
//
// Rule: **the media filename's stem is the same as the chapterSlug** (`media/<chapterSlug>.<ext>`).
// Reasons:
//   1. Identical character sets -- both the media filename stem and chapterSlug are `^[a-z0-9-]+$`
//      (see MEDIA_FILE_PATTERN in ../workspace/paths.ts, CHAPTER_REF_RE in ../story/refs.ts), so
//      sharing a name never collides with either side's validity rules.
//   2. This is exactly an extension of the naming convention this repo already uses for "text" --
//      `content/<chapterSlug>.<lang>.txt` has long used chapterSlug as the filename stem; art follows
//      the same stem into `media/<chapterSlug>.<ext>`, which isn't inventing a new rule, it's
//      applying the existing rule to a second media type.
//   3. Zero I/O, zero guessing -- there's no free-text field to parse and no extra file to read; the
//      chapterSlug string alone determines the media filename. `../webmcp/tools/writeTools.ts`'s
//      `set_page_image` tool follows this exact same rule directly (chapterSlug is the media
//      identifier), so the agent never needs to manage a separate, independent mediaSlug concept.
import type { Choice, Node, StorySpec } from "../contract/types.ts";
import { chapterSlugFromRef } from "../story/refs.ts";
import type { StoryReadiness } from "../story/readiness.ts";

export type MapNodeStatus = "ok" | "missing" | "unknown";

export interface MapNode {
  /** The key in story.yaml's `spec.nodes` -- the map node's unique identity, used as the id by both
   * the DOM and dagre. */
  readonly id: string;
  /** The chapterSlug resolved from this node's own `content` ref -- `undefined` means this node has
   * no resolvable text mapping (see the file header); in that case both `textStatus`/`mediaStatus`
   * are `"unknown"`, and there's no mediaSlug to use either (the page <-> art mapping also needs a
   * chapterSlug). */
  readonly chapterSlug: string | undefined;
  /** The title shown on the card -- the contest structure has no separate page title, so it shows
   * chapterSlug when there is one, and falls back
   * to the node id itself otherwise (at least never an empty string). */
  readonly title: string;
  readonly isStart: boolean;
  readonly isEnding: boolean;
  readonly textStatus: MapNodeStatus;
  readonly mediaStatus: MapNodeStatus;
  /** Whether the card should be drawn with a dashed border (has a gap). */
  readonly hasGap: boolean;
}

export interface MapEdge {
  /** `${the from node's id}>${the to node's id}#${the choice key, or "next"}` -- the same pair of
   * nodes may have more than one edge between them (two different choices branching to the same
   * target), so `from-to` alone can't be used as the id. */
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** A branching choice's edge is labeled with the choice text; a linear `next` edge is `null` (see
   * "edge labels" in the file header). */
  readonly label: string | null;
}

export interface MapCounts {
  /** `null` means readiness doesn't have a full report yet (loading/not-started/unreadable) -- the
   * right column should show "checking" rather than 0/0. */
  readonly textReady: number | null;
  readonly textTotal: number | null;
  readonly mediaReady: number;
  readonly mediaTotal: number;
}

export interface StoryMapModel {
  /** Already ordered (see "reading order" below) -- ./render.ts draws the cards
   * in this order directly, without recomputing it. */
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  readonly counts: MapCounts;
}

function isReadinessReport(readiness: StoryReadiness | null): readiness is Extract<StoryReadiness, { status: "ready" | "incomplete" }> {
  return readiness !== null && (readiness.status === "ready" || readiness.status === "incomplete");
}

/** A branching choice uses its `choices` record key as its reader-facing label. */
function choiceLabel(key: string): string {
  return key;
}

/** Starting from `spec.start`, does a BFS following `next`/`choices` (in Object.entries's existing
 * order) to produce a "reading order" list of node ids -- the map cards' on-screen order
 * follows this order. Nodes that can't be reached (unreachable -- ../contract/validate.ts flags
 * these separately as a warning) are always appended at the end, sorted by id in dictionary order --
 * they still need to appear on the map, just after the nodes that are "reachable from the story's
 * main line". */
function readingOrder(spec: StorySpec): readonly string[] {
  const nodes = spec.nodes ?? {};
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = spec.start && nodes[spec.start] ? [spec.start] : [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    const node = nodes[id];
    if (!node) continue;
    if (node.next && nodes[node.next] && !seen.has(node.next)) queue.push(node.next);
    for (const choice of Object.values(node.choices ?? {})) {
      if (choice.target && nodes[choice.target] && !seen.has(choice.target)) queue.push(choice.target);
    }
  }

  const rest = Object.keys(nodes)
    .filter((id) => !seen.has(id))
    .sort();
  return [...order, ...rest];
}

function buildNode(id: string, node: Node, spec: StorySpec, readiness: StoryReadiness | null, mediaSlugs: ReadonlySet<string>): MapNode {
  const chapterSlug = chapterSlugFromRef(node.content);

  let textStatus: MapNodeStatus = "unknown";
  if (chapterSlug !== undefined && isReadinessReport(readiness)) {
    const missing = readiness.content.missing.some((gap) => gap.chapterSlug === chapterSlug);
    textStatus = missing ? "missing" : "ok";
  }

  let mediaStatus: MapNodeStatus = "unknown";
  if (chapterSlug !== undefined) {
    mediaStatus = mediaSlugs.has(chapterSlug) ? "ok" : "missing";
  }

  return {
    id,
    chapterSlug,
    title: chapterSlug ?? id,
    isStart: spec.start === id,
    isEnding: node.type === "ending",
    textStatus,
    mediaStatus,
    hasGap: textStatus !== "ok" || mediaStatus !== "ok",
  };
}

function buildEdges(spec: StorySpec, order: readonly string[]): readonly MapEdge[] {
  const nodes = spec.nodes ?? {};
  const edges: MapEdge[] = [];
  for (const id of order) {
    const node = nodes[id];
    if (!node) continue;
    if (node.next && nodes[node.next]) {
      edges.push({ id: `${id}>${node.next}#next`, from: id, to: node.next, label: null });
    }
    for (const [key, choice] of Object.entries(node.choices ?? {}) as [string, Choice][]) {
      if (choice.target && nodes[choice.target]) {
        edges.push({ id: `${id}>${choice.target}#${key}`, from: id, to: choice.target, label: choiceLabel(key) });
      }
    }
  }
  return edges;
}

function computeCounts(readiness: StoryReadiness | null, mapNodes: readonly MapNode[], mediaSlugs: ReadonlySet<string>): MapCounts {
  const textCounts = isReadinessReport(readiness)
    ? { textTotal: readiness.content.totalReferenced, textReady: readiness.content.totalReferenced - readiness.content.missing.length }
    : { textTotal: null, textReady: null };

  const chapterSlugs = new Set(mapNodes.map((n) => n.chapterSlug).filter((slug): slug is string => slug !== undefined));
  const mediaTotal = chapterSlugs.size;
  const mediaReady = [...chapterSlugs].filter((slug) => mediaSlugs.has(slug)).length;

  return { ...textCounts, mediaReady, mediaTotal };
}

export interface ComputeStoryMapInput {
  readonly spec: StorySpec;
  /** `null` means readiness has no result yet (the initial screen state right after the controller
   * hydrates, before a full report has been read) -- not an error; the map is still drawn, just with
   * every text status set to "unknown". */
  readonly readiness: StoryReadiness | null;
  /** The set of chapterSlugs in the current workspace that "have art" -- see the note on
   * EditorState.mediaSlugs in ../ui/state.ts. */
  readonly mediaSlugs: ReadonlySet<string>;
}

/** The single public entry point -- story + readiness + the current set of chapterSlugs with art ->
 * the nodes/edges/readiness counts the map needs to draw. A pure function: the same input, called at
 * any time, always produces exactly the same output, reading no external state. */
export function computeStoryMap(input: ComputeStoryMapInput): StoryMapModel {
  const { spec, readiness, mediaSlugs } = input;
  const nodes = spec.nodes ?? {};
  const order = readingOrder(spec);

  const mapNodes = order.map((id) => buildNode(id, nodes[id]!, spec, readiness, mediaSlugs));
  const edges = buildEdges(spec, order);
  const counts = computeCounts(readiness, mapNodes, mediaSlugs);

  return { nodes: mapNodes, edges, counts };
}
