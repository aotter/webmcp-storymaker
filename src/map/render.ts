// DOM + inline SVG render layer -- the screen source
// for the whole "map main view" editor view. ../ui/dom.ts only delegates the whole view to this
// file's `createMapEditorView()` when state.view === "editor"; it no longer assembles any sidebar
// DOM itself.
//
// The page is read-only: selecting a node swaps the right column's content to that page's
// details (full text, art, choice destinations); there is no editing UI anywhere (see
// docs/architecture.md "WebMCP is the only write path").
//
// Follows ../ui/dom.ts's existing "redraw strategy" discipline (see that file's header):
// `createMapEditorView()` uses the "if the screen identity hasn't changed, update in place"
// throttling internally -- the map canvas/right column only recompute the model and redraw the
// canvas when spec/readiness/mediaSlugs actually change (reference-equality comparison); the
// right column's selection details no longer need to protect any input focus (no textarea
// anymore), so it's rebuilt wholesale on every applyState() -- no extra "skip rebuild on
// reference equality" throttling needed -- this view now only calls applyState() on the low
// frequency events hydrate()/openMapNode()/setActiveTab()/previewFromNode(), unlike the old
// version that fired on every keystroke.
//
// Zero unit tests (existing discipline: "the render layer follows the existing convention of not
// testing the DOM") -- all business logic lives in ./model.ts (tested) and ../ui/controller.ts
// (tested); this file only paints their data onto the screen and turns interactions into calls to
// existing controller methods.
import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
import type { StoryUiController } from "../ui/controller.ts";
import type { EditorState } from "../ui/state.ts";
import { el } from "../ui/domHelpers.ts";
import type { StoryReadiness } from "../story/readiness.ts";
import { computeStoryMap, type MapNode, type StoryMapModel } from "./model.ts";
import { layoutStoryMap, type StoryMapLayout, type LayoutPoint } from "./layout.ts";

// Pan/zoom on the map canvas is handled by @panzoom/panzoom (pinned to
// 4.6.2) -- we don't reimplement the drag/wheel-zoom coordinate math ourselves. The API was
// checked against the actual dist/src/panzoom.d.ts/README.md shipped in node_modules (not
// recalled from memory): `Panzoom(elem, options)` returns a `PanzoomObject` that pans/zooms
// `elem` itself via CSS transform; `canvas: true` makes Panzoom attach its pointer down/move/up
// listeners to `elem.parentElement` (here, `canvasWrap`) instead of `elem` (`canvasContainer`)
// itself, giving the effect of "pressing down anywhere in the visible area starts a pan", not
// limited to the canvas's existing content area.
//
// `excludeClass` (default "panzoom-exclude") -- see README FAQ #3: any ancestor element carrying
// this class makes Panzoom's down handler skip that event entirely, and mouse/touch events keep
// propagating normally to the elements underneath. Node cards (<button>, see buildNodeCard()),
// zoom buttons, and readiness chips all need this class, or Panzoom's drag detection would
// swallow the click and no node could ever be selected.
const PANZOOM_EXCLUDE_CLASS = "panzoom-exclude";
const MAP_MIN_SCALE = 0.4;
const MAP_MAX_SCALE = 2.5;

export interface MapEditorView {
  readonly element: HTMLElement;
  update(state: EditorState): void;
  /** Release resources held by this map view -- currently only the thumbnail object URLs
   * accumulated in `thumbCache` (see the `loadThumbnail()` header). ../ui/dom.ts only calls this
   * when actually leaving the editor view (the view kind changes -- not when switching tabs
   * between map and preview reader). */
  dispose(): void;
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/** Thumbnail blob URL cache -- keyed by `${storySlug}::${chapterSlug}`. When the agent overwrites
 * a page's art via set_page_image, does hydrate() rebuild the caller of this map view instance
 * wholesale? No -- the map view is "built once on entering editor, not rebuilt when switching
 * tabs" (see the existing discipline in ../ui/dom.ts), but after every hydrate() the
 * `state.mediaSlugs`/`state.spec` references are replaced (see the reference-equality comparison
 * in applyState() below), so renderCanvas() still ends up calling loadThumbnail() again -- but
 * the key here doesn't fold in a revision or a content hash of the image, so overwriting the art
 * for the same chapterSlug still resolves to the cached object URL of the old image; it does not
 * invalidate automatically. This is a deliberate known limitation (a choice not to build this, see
 * the "cache invalidation rationale" below), not an oversight. */
const thumbCacheKey = (storySlug: string, chapterSlug: string) => `${storySlug}::${chapterSlug}`;

// Cache invalidation rationale: an earlier design made "overwriting the
// art on the same page" impossible (once adopted, a mediaSlug's bytes
// could never change again, because of an adopted-conflict rule that forbade adopting a
// second time); that has since changed to "the agent can overwrite it at any time via
// set_page_image" -- the cache's semantics are therefore no longer inherently safe. We
// deliberately don't add cache invalidation
// logic here (e.g. folding revision into the key), because the only thing the user can do when
// this happens (the agent just overwrote a page's art and the thumbnail hasn't updated yet) is hit
// "refresh" -- and that replaces the entire editor view (the view-kind guard that calls
// disposeEditorMount() in ../ui/dom.ts compares view kind; the same "editor" view won't trigger a
// map-view rebuild), so strictly speaking even a refresh won't clear the cache. Within the minimal
// implementation scope, this is a known stale-thumbnail visual risk, not a data-correctness risk --
// the workspace's actual content is always correct; only this in-memory thumbnail cache may show a
// stale image, until the tab is reloaded (F5) or closed.
function loadThumbnail(img: HTMLImageElement, controller: StoryUiController, cache: Map<string, string>, cacheKey: string, mediaSlug: string): void {
  const cached = cache.get(cacheKey);
  if (cached) {
    img.src = cached;
    return;
  }
  void controller.readAcceptedMedia(mediaSlug).then((result) => {
    if (!result) return; // The file turned out not to exist at read time -- keep the placeholder, don't force a broken image
    const blob = new Blob([new Uint8Array(result.bytes)], { type: mimeForExt(result.ext) });
    const url = URL.createObjectURL(blob);
    cache.set(cacheKey, url);
    img.src = url;
  });
}

function emptyThumb(label: string): HTMLElement {
  const box = el("div", "ll-map-node-thumb ll-map-node-thumb-empty");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("width", "20");
  icon.setAttribute("height", "20");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.6");
  icon.innerHTML =
    '<rect x="3" y="4" width="18" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3 16l5-4 4 3 4-5 5 6"/>';
  box.appendChild(icon);
  box.appendChild(el("span", undefined, label));
  return box;
}

function statusDot(status: MapNode["textStatus"]): HTMLElement {
  return el("span", `ll-map-dot ll-map-dot-${status}`);
}

// ---------------------------------------------------------------------------
// Map canvas (node cards + SVG edges)
// ---------------------------------------------------------------------------

function buildNodeCard(
  node: MapNode,
  box: { x: number; y: number; width: number; height: number },
  storySlug: string,
  selected: boolean,
  controller: StoryUiController,
  thumbCache: Map<string, string>,
): HTMLElement {
  const card = el(
    "button",
    `ll-map-node ${PANZOOM_EXCLUDE_CLASS}${node.hasGap ? " ll-map-node-gap" : ""}${selected ? " ll-map-node-selected" : ""}`,
  ) as HTMLButtonElement;
  card.type = "button";
  card.style.left = `${box.x}px`;
  card.style.top = `${box.y}px`;
  card.style.width = `${box.width}px`;
  // `height` changed to `minHeight` --
  // dagre layout still uses ./layout.ts's MAP_NODE_WIDTH/HEIGHT as the fixed node-spacing budget
  // (see that file's header), but now that the card body drops the summary line and the thumbnail
  // switches to 4:3 (taller than the old fixed 78px), the actual content height is no longer
  // reliably equal to that budget -- `minHeight` lets the card grow to fit its actual content
  // without squeezing or clipping the art/title; ./layout.ts's nodesep (vertical node spacing,
  // 40px) leaves enough buffer that adjacent cards won't overlap because of this.
  card.style.minHeight = `${box.height}px`;

  if (node.chapterSlug === undefined) {
    card.appendChild(emptyThumb("No matching text"));
  } else if (node.mediaStatus === "ok") {
    const thumb = el("div", "ll-map-node-thumb");
    const img = document.createElement("img");
    img.alt = `${node.title} art`;
    loadThumbnail(img, controller, thumbCache, thumbCacheKey(storySlug, node.chapterSlug), node.chapterSlug);
    thumb.appendChild(img);
    const statusRow = el("div", "ll-map-node-status");
    statusRow.appendChild(statusDot(node.textStatus));
    statusRow.appendChild(statusDot(node.mediaStatus));
    thumb.appendChild(statusRow);
    card.appendChild(thumb);
  } else {
    card.appendChild(emptyThumb("No art yet"));
  }

  const titleRow = el("div", "ll-map-node-title-row");
  titleRow.appendChild(el("span", "ll-map-node-title", node.title));
  card.appendChild(titleRow);

  // Removed the text-summary line on the
  // card -- the thumbnail + title are already enough to identify which page it is, and the summary
  // is left to the right column's selection details. The "N choices" chip was also removed (the
  // number of choices is already visible at a glance from the edges leaving this node on the map,
  // no need to repeat it as text). The Start/Ending pill badges next to the title are
  // gone too; the role is shown once, as quiet text in the card's foot (a one-page story can be
  // both Start and Ending, so both may appear).
  if (node.isStart || node.isEnding) {
    const foot = el("div", "ll-map-node-foot");
    if (node.isStart) foot.appendChild(el("span", "ll-map-node-chip", "Start"));
    if (node.isEnding) foot.appendChild(el("span", "ll-map-node-chip", "Ending"));
    card.appendChild(foot);
  }

  if (node.chapterSlug === undefined) {
    card.disabled = true;
    card.title = "This node has no matching text to resolve, so its details can't be viewed.";
  } else {
    const chapterSlug = node.chapterSlug;
    card.addEventListener("click", () => controller.openMapNode(chapterSlug));
  }

  return card;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function pointsToPathD(points: readonly LayoutPoint[]): string {
  if (points.length === 0) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

function buildEdgesSvg(model: StoryMapModel, layout: ReturnType<typeof layoutStoryMap>): { readonly svg: SVGSVGElement; readonly labels: readonly HTMLElement[] } {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "ll-map-edges");
  svg.setAttribute("width", String(layout.width));
  svg.setAttribute("height", String(layout.height));
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);

  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", "ll-map-arrow");
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "7");
  marker.setAttribute("markerHeight", "7");
  marker.setAttribute("orient", "auto-start-reverse");
  const arrowPath = document.createElementNS(SVG_NS, "path");
  arrowPath.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  arrowPath.setAttribute("class", "ll-map-arrowhead");
  marker.appendChild(arrowPath);
  const defs = document.createElementNS(SVG_NS, "defs");
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Edge labels (choice text) are HTML elements, not SVG <text> -- they need CSS pill styling
  // (rounded background, shadow, text truncation) that SVG <text> can't reproduce. Returned to the
  // caller (renderCanvas()) to be overlaid on the canvas, not appended into this <svg> itself
  // (an <svg> can only hold SVG elements).
  const labels: HTMLElement[] = [];
  for (const edge of model.edges) {
    const points = layout.edgePoints.get(edge.id) ?? [];
    if (points.length < 2) continue; // No routing points found -- skip this edge rather than draw a half-broken line
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", pointsToPathD(points));
    path.setAttribute("class", "ll-map-edge-line");
    path.setAttribute("marker-end", "url(#ll-map-arrow)");
    svg.appendChild(path);

    if (edge.label !== null) {
      const mid = points[Math.floor(points.length / 2)]!;
      const label = el("div", "ll-map-edge-label", edge.label);
      label.title = edge.label; // full text on hover; the pill clamps to two lines
      label.style.left = `${mid.x}px`;
      label.style.top = `${mid.y}px`;
      labels.push(label);
    }
  }

  return { svg, labels };
}

const EMPTY_LAYOUT: StoryMapLayout = { nodeBoxes: new Map(), edgePoints: new Map(), width: 0, height: 0 };

/** Returns the layout (coordinates) drawn this time -- added by the map interaction batch:
 * createMapEditorView()'s ensureNodeVisible()/centerFit() need to know exactly where each card was
 * drawn to compute the pan amount, without recomputing layoutStoryMap() themselves (this isn't the
 * only caller of this function, and callers shouldn't be assumed to always recompute it). */
function renderCanvas(container: HTMLElement, model: StoryMapModel, storySlug: string, selectedChapterSlug: string | null, controller: StoryUiController, thumbCache: Map<string, string>): StoryMapLayout {
  container.replaceChildren();
  if (model.nodes.length === 0) {
    container.appendChild(el("p", "ll-empty", "This story doesn't have any nodes yet."));
    return EMPTY_LAYOUT;
  }

  const layout = layoutStoryMap(model.nodes, model.edges);
  const canvas = el("div", "ll-map-canvas");
  canvas.style.width = `${layout.width}px`;
  canvas.style.height = `${layout.height}px`;
  const { svg: edgesSvg, labels } = buildEdgesSvg(model, layout);
  canvas.appendChild(edgesSvg);
  for (const label of labels) canvas.appendChild(label);

  for (const node of model.nodes) {
    const box = layout.nodeBoxes.get(node.id);
    if (!box) continue; // Defensive: every node has already been through setNode(), see ./layout.ts
    const selected = node.chapterSlug !== undefined && node.chapterSlug === selectedChapterSlug;
    canvas.appendChild(buildNodeCard(node, box, storySlug, selected, controller, thumbCache));
  }
  container.appendChild(canvas);
  return layout;
}

// ---------------------------------------------------------------------------
// Readiness chips in the top-left corner of the map area (floats
// over the map area instead of a standalone right-column panel) -- three chips (missing
// text/missing art/structure issues) float in canvasWrap's top-left corner (see
// createMapEditorView()), not part of ../ui/dom.ts's top level, no heading, dimmed when the count
// is 0. Clicking a chip reuses the existing "select node" mechanism (controller.openMapNode()) --
// the selected node picks up the existing .ll-map-node-selected style (equivalent to "highlight"),
// the right column details also switch to that page, and the map view (createMapEditorView()'s
// ensureNodeVisible()) already pans to bring a selected node into view when it's outside the
// visible area, so clicking a chip doesn't need to invent a separate "highlight" visual language.
// A chip may map to multiple pages (e.g. "missing text: 3"); clicking selects the first one (in
// reading order) -- the remaining pages are still drawn on the map with the existing dashed-box
// rule (hasGap), and the user can click through them one by one.
// ---------------------------------------------------------------------------

function isReadinessReport(readiness: StoryReadiness | null): readiness is Extract<StoryReadiness, { status: "ready" | "incomplete" }> {
  return readiness !== null && (readiness.status === "ready" || readiness.status === "incomplete");
}

/** Parses the node id a story-contract validate() Diagnostic.path (../contract/types.ts) points
 * to -- the shape is a prefix like `/nodes/<id>` or `/nodes/<id>/choices/<key>/...` (see how
 * ../contract/validate.ts builds `path: p` / `${p}/...` everywhere -- p is always
 * `/nodes/${id}`). Returns undefined for anything not in that shape (e.g. `/metadata/slug`,
 * `/start`, `/specVersion`) -- these diagnostics don't map to any page, so the "structure issues"
 * chip can't jump to them; not every structural error has a page to jump to. */
function diagnosticNodeId(path: string): string | undefined {
  const match = /^\/nodes\/([^/]+)/.exec(path);
  return match?.[1];
}

interface ReadinessChipTarget {
  readonly count: number;
  /** The list of chapterSlugs, in reading order (model.nodes's existing order), that can be safely
   * passed to controller.openMapNode() -- an empty array means clicking this chip has no page to
   * jump to, see the header above. */
  readonly chapterSlugs: readonly string[];
}

function computeReadinessChipTargets(
  model: StoryMapModel,
  readiness: StoryReadiness | null,
): { readonly missingText: ReadinessChipTarget; readonly missingMedia: ReadinessChipTarget; readonly structuralIssue: ReadinessChipTarget } {
  const missingTextSlugs = isReadinessReport(readiness) ? readiness.content.missing.map((g) => g.chapterSlug) : [];
  const missingMediaSlugs = model.nodes.filter((n) => n.mediaStatus === "missing" && n.chapterSlug !== undefined).map((n) => n.chapterSlug!);

  let structuralIssueSlugs: string[] = [];
  if (isReadinessReport(readiness)) {
    const nodeById = new Map(model.nodes.map((n) => [n.id, n] as const));
    const seen = new Set<string>();
    for (const diag of readiness.diagnostics.errors) {
      const nodeId = diagnosticNodeId(diag.path);
      const chapterSlug = nodeId !== undefined ? nodeById.get(nodeId)?.chapterSlug : undefined;
      if (chapterSlug !== undefined && !seen.has(chapterSlug)) {
        seen.add(chapterSlug);
        structuralIssueSlugs.push(chapterSlug);
      }
    }
  }

  return {
    missingText: { count: isReadinessReport(readiness) ? readiness.content.missing.length : 0, chapterSlugs: missingTextSlugs },
    missingMedia: { count: model.counts.mediaTotal - model.counts.mediaReady, chapterSlugs: missingMediaSlugs },
    structuralIssue: { count: isReadinessReport(readiness) ? readiness.diagnostics.errors.length : 0, chapterSlugs: structuralIssueSlugs },
  };
}

function buildChip(label: string, target: ReadinessChipTarget, loading: boolean, controller: StoryUiController): HTMLElement {
  const clickable = !loading && target.chapterSlugs.length > 0;
  const chip = el("button", `ll-map-chip${target.count === 0 ? " ll-map-chip-zero" : ""} ${PANZOOM_EXCLUDE_CLASS}`) as HTMLButtonElement;
  chip.type = "button";
  chip.disabled = !clickable;
  chip.appendChild(el("span", "ll-map-chip-label", label));
  chip.appendChild(el("span", "ll-map-chip-count", loading ? "…" : String(target.count)));
  if (clickable) {
    const firstChapterSlug = target.chapterSlugs[0]!;
    chip.addEventListener("click", () => controller.openMapNode(firstChapterSlug));
  }
  return chip;
}

function renderReadinessChips(container: HTMLElement, model: StoryMapModel, readiness: StoryReadiness | null, loading: boolean, controller: StoryUiController): void {
  container.replaceChildren();
  const targets = computeReadinessChipTargets(model, readiness);
  container.appendChild(buildChip("Missing text", targets.missingText, loading || readiness === null, controller));
  container.appendChild(buildChip("Missing art", targets.missingMedia, loading, controller));
  container.appendChild(buildChip("Structure issues", targets.structuralIssue, loading || readiness === null, controller));
}

// ---------------------------------------------------------------------------
// Right column: read-only details for the selected node -- readiness has
// moved to the chips in the map area's top-left corner (see above), so the right column now only
// has this one block left.
// ---------------------------------------------------------------------------

function arrowIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.4");
  svg.innerHTML = '<path d="M5 12h14M13 6l6 6-6 6"/>';
  return svg;
}

function renderDetailPanel(model: StoryMapModel, state: EditorState, controller: StoryUiController): HTMLElement {
  const panel = el("section", "ll-panel");

  const selectedChapterSlug = state.mapSelection;
  if (selectedChapterSlug === null) {
    panel.appendChild(el("p", "ll-empty", "Select a node on the map to see its text, art, and choice destinations."));
    return panel;
  }

  const node = model.nodes.find((n) => n.chapterSlug === selectedChapterSlug);
  if (!node) {
    panel.appendChild(el("p", "ll-empty", "This node no longer exists -- please select another one."));
    return panel;
  }

  const badgeRow = el("div", "ll-detail-badges");
  badgeRow.appendChild(el("span", "ll-badge ll-badge-selected", "Selected"));
  const closeButton = el("button", "ll-detail-close", "✕ Deselect") as HTMLButtonElement;
  closeButton.type = "button";
  closeButton.addEventListener("click", () => controller.closeMapNode());
  badgeRow.appendChild(closeButton);
  panel.appendChild(badgeRow);

  panel.appendChild(el("h3", "ll-detail-title", node.title));

  const thumb = el("div", "ll-detail-thumb");
  if (node.mediaStatus === "ok") {
    const img = document.createElement("img");
    img.alt = `${node.title} art`;
    void controller.readAcceptedMedia(selectedChapterSlug).then((result) => {
      if (!result) return;
      const blob = new Blob([new Uint8Array(result.bytes)], { type: mimeForExt(result.ext) });
      img.src = URL.createObjectURL(blob);
    });
    thumb.appendChild(img);
  } else {
    thumb.appendChild(emptyThumb("No art yet"));
  }
  panel.appendChild(thumb);

  const text = state.pagePreviews.get(selectedChapterSlug);
  panel.appendChild(el("p", "ll-detail-text", text && text.trim().length > 0 ? text : "(This page doesn't have any text yet)"));

  // Map interaction batch: both destinations and sources are clickable -- clicking selects that
  // node (../ui/controller.ts openMapNode()), the map pans to bring it into view (see
  // createMapEditorView()'s ensureNodeVisible()), and the right-column details switch to that
  // page. A target node without a resolvable chapterSlug (same existing rule as buildNodeCard())
  // can't be selected, and falls back to a plain <div> instead of pretending to be clickable.
  const linkRow = (other: MapNode | undefined, fallbackId: string, primary: string, dest: string): HTMLElement => {
    const clickable = other?.chapterSlug !== undefined;
    const row = el(clickable ? "button" : "div", `ll-choice-row${clickable ? " " + PANZOOM_EXCLUDE_CLASS : ""}`);
    if (clickable) {
      (row as HTMLButtonElement).type = "button";
      const otherChapterSlug = other!.chapterSlug!;
      row.addEventListener("click", () => controller.openMapNode(otherChapterSlug));
    }
    row.appendChild(el("span", "ll-choice-text", primary));
    const destEl = el("span", "ll-choice-dest");
    destEl.appendChild(document.createTextNode(dest || fallbackId));
    destEl.appendChild(arrowIcon());
    row.appendChild(destEl);
    return row;
  };

  // "Previous pages" -- which pages' next/choices lead to this page (incoming edges). Skip this
  // section entirely for a starting page with no incoming edges.
  const incoming = model.edges.filter((e) => e.to === node.id);
  if (incoming.length > 0) {
    panel.appendChild(el("p", "ll-detail-sub", "Previous pages"));
    const list = el("div", "ll-choice-list");
    for (const edge of incoming) {
      const source = model.nodes.find((n) => n.id === edge.from);
      list.appendChild(linkRow(source, edge.from, source?.title ?? edge.from, edge.label ?? "Next"));
    }
    panel.appendChild(list);
  }

  const outgoing = model.edges.filter((e) => e.from === node.id);
  if (outgoing.length > 0) {
    panel.appendChild(el("p", "ll-detail-sub", "Choices and destinations"));
    const list = el("div", "ll-choice-list");
    for (const edge of outgoing) {
      const target = model.nodes.find((n) => n.id === edge.to);
      list.appendChild(linkRow(target, edge.to, edge.label ?? "Next", target?.title ?? edge.to));
    }
    panel.appendChild(list);
  } else if (node.isEnding) {
    panel.appendChild(el("p", "ll-empty", "This is one of the story's endings -- there are no further choices."));
  }

  const cta = el("button", "ll-cta", "Preview from this page") as HTMLButtonElement;
  cta.type = "button";
  cta.addEventListener("click", () => controller.previewFromNode(node.id));
  panel.appendChild(cta);

  return panel;
}

function renderAside(container: HTMLElement, model: StoryMapModel, state: EditorState, controller: StoryUiController): void {
  container.replaceChildren();
  container.appendChild(renderDetailPanel(model, state, controller));
}

// ---------------------------------------------------------------------------
// Map pan/zoom -- a thin wrapper around @panzoom/panzoom (zoom buttons, centering, auto-pan into
// view when a node is selected).
// ---------------------------------------------------------------------------

/** The readiness chips row in the
 * top-left corner (see renderReadinessChips()) floats over canvasWrap, covering the first row of
 * cards that would otherwise be drawn starting at (0,0) -- this function measures the chip row's
 * *actual current* height (not a hardcoded guess -- the chip row's text/width changes with the
 * readiness content, so measuring live is the only way to get it right), and returns
 * "chip row height + 16px" for centerFit()/ensureNodeVisible() to use as the top margin reserved
 * for the chips. Falls back to just 16px if the chips container has no chips at all (shouldn't
 * happen in practice -- renderReadinessChips() always draws three). */
function chipRowTopInset(chipsEl: HTMLElement): number {
  // chips is an absolutely-positioned element inside canvasWrap (position: relative):
  // offsetTop is its distance from the wrap's top edge (CSS top: 14px). The original version only
  // counted height + 16 and missed this 14px, leaving cards only 2px below the chip row's bottom
  // edge, which looked cramped.
  return chipsEl.offsetTop + chipsEl.offsetHeight + 16;
}

/** "Center" -- reset and fit the whole map into the visible area, not a plain
 * panzoom.reset() (that only returns to scale 1, pan (0,0), with no guarantee the whole map
 * actually fits in the current visible area). With zero nodes (layout.width/height both 0), only
 * reset -- no attempt to divide by zero (topInset is meaningless here anyway -- an empty map has
 * no cards that need to avoid the chip row).
 *
 * `topInset`: the map's "visible height" minus the chip row
 * (`chipRowTopInset()`) is what's used to compute the fit ratio and centered position -- so the
 * whole map is always drawn starting below the chip row and never gets covered; this function is
 * also the single implementation shared by both createMapEditorView()'s mount-time "initial
 * position" and the zoom controls' "center" button (see the call sites) -- the topInset margin
 * logic lives in exactly one place, so the two situations can't drift into inconsistent results. */
function centerFit(panzoom: PanzoomObject, wrapEl: HTMLElement, layout: StoryMapLayout, animate: boolean, topInset: number): void {
  if (layout.width === 0 || layout.height === 0) {
    panzoom.reset({ animate });
    return;
  }
  const wrapRect = wrapEl.getBoundingClientRect();
  const margin = FIT_MARGIN;
  const availableWidth = Math.max(0, wrapRect.width - 2 * margin);
  const availableHeight = Math.max(0, wrapRect.height - topInset - margin);
  const fit = Math.min(availableWidth / layout.width, availableHeight / layout.height);
  // Never enlarge past natural size on a fit: a five-card story on a wide screen should read at 1x,
  // not balloon to fill the screen. MAP_MIN_SCALE still bounds huge stories.
  const scale = Math.min(1, Math.max(MAP_MIN_SCALE, fit));
  // When the map is still bigger than the visible area at MAP_MIN_SCALE, don't center -- align it
  // to the left margin / just below the chip row instead, otherwise the first row of cards would
  // get pushed behind the chip row or off-screen.
  const offsetX = Math.max(margin, (wrapRect.width - layout.width * scale) / 2);
  const offsetY = Math.max(topInset, topInset + (availableHeight - layout.height * scale) / 2);
  const pan = panForScreenOrigin({ x: offsetX, y: offsetY }, scale, layout);
  // See "A note on the async nature of Panzoom" in the node_modules README: zoom before pan (we're
  // not using the contain option here; the two calls happening synchronously back to back is fine
  // on its own, but we still follow the order the docs recommend).
  panzoom.zoom(scale, { animate });
  panzoom.pan(pan.x, pan.y, { animate });
}

const FIT_MARGIN = 24;

// Panzoom (HTML element, default transform-origin 50% 50%) applies `scale(s) translate(x, y)` to
// the canvas element, whose untransformed box is layout.width x layout.height sitting at the wrap's
// (0, 0). So a layout point p lands on screen at s*p + s*pan + C*(1 - s), where C is the element's
// centre -- pan is in unscaled canvas units and the origin is the centre, not the top-left. Both
// helpers below are the only place that formula lives; the earlier code assumed a top-left origin
// and screen-pixel pans, which made small stories overflow both edges (scale > 1 grows outward
// from the centre) and big ones drift. Panzoom's own README warns that changing `origin` breaks
// focal-point (wheel) zooming, so we keep the default and do the conversion here instead.
function layoutToScreen(p: { x: number; y: number }, scale: number, pan: { x: number; y: number }, layout: StoryMapLayout): { x: number; y: number } {
  return {
    x: scale * p.x + scale * pan.x + (layout.width / 2) * (1 - scale),
    y: scale * p.y + scale * pan.y + (layout.height / 2) * (1 - scale),
  };
}

/** Inverse of layoutToScreen() for p = (0, 0): the pan that puts the canvas's top-left corner at
 * the given screen offset inside the wrap. */
function panForScreenOrigin(offset: { x: number; y: number }, scale: number, layout: StoryMapLayout): { x: number; y: number } {
  return {
    x: (offset.x - (layout.width / 2) * (1 - scale)) / scale,
    y: (offset.y - (layout.height / 2) * (1 - scale)) / scale,
  };
}

/** When a node is selected, if it's currently outside the visible area (or clipped at the visible
 * area's edge), pan to bring it fully into view. Only pans, never
 * changes the zoom level; does nothing if the card is already fully inside the visible area
 * (including the `margin` buffer ring), so selecting doesn't needlessly recenter every time. The
 * top-edge buffer ring uses `Math.max(margin, topInset)` -- a node that's technically "top ≥ 24px
 * in wrap coordinates" but still covered by the chip row shouldn't be misjudged as already visible
 * (only this top-edge threshold accounts for the chip row; the other three edges and
 * centerFit()'s initial/center call sites use plain margins). */
function ensureNodeVisible(panzoom: PanzoomObject, wrapEl: HTMLElement, box: { x: number; y: number; width: number; height: number }, layout: StoryMapLayout, topInset: number): void {
  const scale = panzoom.getScale();
  const pan = panzoom.getPan();
  const wrapRect = wrapEl.getBoundingClientRect();
  const margin = FIT_MARGIN;
  const topMargin = Math.max(margin, topInset);

  const { x: left, y: top } = layoutToScreen(box, scale, pan, layout);
  const right = left + box.width * scale;
  const bottom = top + box.height * scale;

  // dx/dy are screen pixels; Panzoom's relative pan is in unscaled canvas units, hence the / scale.
  let dx = 0;
  let dy = 0;
  if (left < margin) dx = margin - left;
  else if (right > wrapRect.width - margin) dx = wrapRect.width - margin - right;
  if (top < topMargin) dy = topMargin - top;
  else if (bottom > wrapRect.height - margin) dy = wrapRect.height - margin - bottom;

  if (dx !== 0 || dy !== 0) panzoom.pan(dx / scale, dy / scale, { animate: true, relative: true });
}

function zoomButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = el("button", `ll-map-zoom-btn ${PANZOOM_EXCLUDE_CLASS}`, label) as HTMLButtonElement;
  btn.type = "button";
  btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
}

/** `getPanzoom` is a getter, not a direct `PanzoomObject` -- see the "deferred initialization"
 * note in createMapEditorView(): these buttons' `onClick` handlers may get attached to the DOM
 * before the panzoom instance actually exists (in theory the user can't click into that brief
 * window, but the caller doesn't need to synchronously wait for it just for this). `chipsEl` lets
 * the "center" button measure the chip row's height live (see `chipRowTopInset()`). */
function buildZoomControls(getPanzoom: () => PanzoomObject | undefined, wrapEl: HTMLElement, chipsEl: HTMLElement, getLayout: () => StoryMapLayout): HTMLElement {
  const controls = el("div", `ll-map-zoom-controls ${PANZOOM_EXCLUDE_CLASS}`);
  controls.appendChild(zoomButton("＋", "Zoom in", () => getPanzoom()?.zoomIn({ animate: true })));
  controls.appendChild(zoomButton("－", "Zoom out", () => getPanzoom()?.zoomOut({ animate: true })));
  controls.appendChild(
    zoomButton("Center", "Center and fit the whole map into the visible area", () => {
      const panzoom = getPanzoom();
      if (panzoom) centerFit(panzoom, wrapEl, getLayout(), true, chipRowTopInset(chipsEl));
    }),
  );
  return controls;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function createMapEditorView(initial: EditorState, controller: StoryUiController): MapEditorView {
  const element = el("div", "ll-map-shell");
  const canvasWrap = el("div", "ll-map-canvas-wrap");
  const canvasContainer = document.createElement("div");
  canvasContainer.className = "ll-map-canvas-container";
  canvasWrap.appendChild(canvasContainer);

  // Panzoom manages canvasContainer's CSS transform; `canvas: true`
  // attaches the drag pointer listeners to canvasWrap (its parentElement) -- see the note near the
  // import at the top of the file. Range 0.4-2.5. `cursor: "grab"` gives a visual
  // hint that "you can drag here"; `disablePan`/`disableZoom` are left unset (default drag/zoom
  // stays enabled); `excludeClass` uses the default "panzoom-exclude".
  //
  // Deferred initialization (a real problem hit in a real browser, not theoretical): `Panzoom()`'s
  // constructor checks whether `elem` is already attached to the real document, and throws
  // ("Panzoom should be called on elements that have been attached to the DOM") if not. But at the
  // moment `createMapEditorView()` runs, this whole subtree (`element`) is still detached DOM (the
  // caller, ../ui/dom.ts's `buildEditorMount()`/`applyEditorMount()`, hasn't attached it into
  // `main` yet) -- calling `Panzoom(canvasContainer, ...)` synchronously here is guaranteed to
  // throw. Deferred by one microtask via `queueMicrotask()` instead: ../ui/dom.ts's render() is a
  // single synchronous call (build -> apply -> `main.replaceChildren()`, all done synchronously),
  // so this initialization, queued as a microtask, is guaranteed to run only after render()'s
  // whole synchronous block finishes -- i.e. only after this subtree is actually attached to the
  // document -- so the user can never beat it to clicking a not-yet-built zoom button within that
  // window (microtasks run before any subsequent user input event is processed). `panzoom` is
  // therefore declared as `PanzoomObject | undefined`, and every place that uses it must
  // defensively handle the not-yet-built case (see `onWheel`/`buildZoomControls()`/
  // `ensureNodeVisible()` call sites and `dispose()` below).
  let currentLayout: StoryMapLayout = EMPTY_LAYOUT;
  // `chips` has to be declared
  // before buildZoomControls()/panzoom initialization (not a timing issue -- the queueMicrotask()
  // callback naturally runs after both of these are already built, see the note below -- it's
  // simply that both of them need a reference to the same `chips` element to measure the chip
  // row's height, so the declaration order has to precede its use).
  const chips = el("div", "ll-map-chips");
  const zoomControls = buildZoomControls(() => panzoom, canvasWrap, chips, () => currentLayout);

  canvasWrap.appendChild(chips);
  canvasWrap.appendChild(zoomControls);
  element.appendChild(canvasWrap);

  // Panzoom manages canvasContainer's CSS transform; `canvas: true`
  // attaches the drag pointer listeners to canvasWrap (its parentElement) -- see the note near the
  // import at the top of the file. Range 0.4-2.5. `cursor: "grab"` gives a visual
  // hint that "you can drag here"; `disablePan`/`disableZoom` are left unset (default drag/zoom
  // stays enabled); `excludeClass` uses the default "panzoom-exclude".
  //
  // Deferred initialization (a real problem hit in a real browser, not theoretical): `Panzoom()`'s
  // constructor checks whether `elem` is already attached to the real document, and throws
  // ("Panzoom should be called on elements that have been attached to the DOM") if not. But at the
  // moment `createMapEditorView()` runs, this whole subtree (`element`) is still detached DOM (the
  // caller, ../ui/dom.ts's `buildEditorMount()`/`applyEditorMount()`, hasn't attached it into
  // `main` yet) -- calling `Panzoom(canvasContainer, ...)` synchronously here is guaranteed to
  // throw. Deferred by one microtask via `queueMicrotask()` instead: ../ui/dom.ts's render() is a
  // single synchronous call (build -> apply -> `main.replaceChildren()`, all done synchronously),
  // so this initialization, queued as a microtask, is guaranteed to run only after render()'s
  // whole synchronous block finishes -- i.e. only after this subtree is actually attached to the
  // document -- so the user can never beat it to clicking a not-yet-built zoom button within that
  // window (microtasks run before any subsequent user input event is processed). `panzoom` is
  // therefore declared as `PanzoomObject | undefined`, and every place that uses it must
  // defensively handle the not-yet-built case (see `onWheel`/`buildZoomControls()`/
  // `ensureNodeVisible()` call sites and `dispose()` below).
  //
  // Within the same microtask, once panzoom is built, call
  // `centerFit()` once right away as the "initial position" -- the `currentLayout` read here is
  // already the real layout computed by `applyState(initial)` (below, called synchronously at the
  // end of this function), not the `EMPTY_LAYOUT` from declaration time (the microtask guarantees
  // it runs after the rest of this function's synchronous code). Rather than computing a separate
  // "initial pan amount" formula outside of what centerFit()/the zoom buttons share, this calls the
  // same function directly, so the margin rule is guaranteed consistent between the two situations
  // (on mount / user clicks "center") instead of each maintaining its own formula. `animate:
  // false` -- there's no need to run a pan animation right at mount time.
  let panzoom: PanzoomObject | undefined;
  let disposed = false;
  // The initial position only fits once, and only once there's actually "cards to show, and the
  // wrap has a size" -- at mount time the spec usually hasn't loaded back from IndexedDB yet
  // (layout is empty), or the wrap is still 0x0; fitting at that point would be meaningless, so we
  // wait for the next applyState() to try again. A user reported: the initial position was covered
  // by the chip row, and only moved correctly after clicking a card.
  let fittedOnce = false;
  // Panzoom's constructor does another pan inside a setTimeout(0), back to
  // (startX, startY) = (0, 0) (see the "Wait for scale to update" section in
  // node_modules/@panzoom/panzoom/dist/panzoom.js) -- a fit done before that runs gets zeroed out
  // by it (what the user actually saw: the initial position sat under the chips, and only moved
  // correctly after clicking a card). So the initial fit always waits for panzoomSettled (our own
  // setTimeout queued after Panzoom's) before running.
  let panzoomSettled = false;
  const tryInitialFit = () => {
    if (fittedOnce || !panzoom || !panzoomSettled) return;
    if (currentLayout.width > 0 && canvasWrap.clientWidth > 0) {
      centerFit(panzoom, canvasWrap, currentLayout, false, chipRowTopInset(chips));
      fittedOnce = true;
    }
  };
  queueMicrotask(() => {
    if (disposed) return; // Edge case: this view was already unmounted between the microtask being queued and actually running
    panzoom = Panzoom(canvasContainer, {
      canvas: true,
      minScale: MAP_MIN_SCALE,
      maxScale: MAP_MAX_SCALE,
      cursor: "grab",
      excludeClass: PANZOOM_EXCLUDE_CLASS,
    });
    setTimeout(() => {
      if (disposed) return;
      panzoomSettled = true;
      tryInitialFit();
    });
  });

  // Panzoom's wheel events on the map must call preventDefault synchronously (so the
  // first wheel event is consumed) -- see the
  // overscroll-behavior-x rule header in ../ui/style.css/../preview/reader.css. This step is
  // independent of whether panzoom has finished initializing -- the browser's native
  // gesture/scroll behavior must be blocked regardless of whether the microtask above has run yet.
  // Only Ctrl+wheel/trackpad two-finger pinch-zoom (Chrome's synthesized wheel event for a
  // two-finger pinch carries ctrlKey) actually calls panzoom.zoomWithWheel(); every other wheel
  // event only gets preventDefault, without triggering any pan (this canvas doesn't support "plain
  // wheel scrolling" -- the wheel's only purpose here is zooming).
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (event.ctrlKey) panzoom?.zoomWithWheel(event);
  };
  canvasWrap.addEventListener("wheel", onWheel, { passive: false });

  const aside = el("aside", "ll-map-aside");
  element.appendChild(aside);

  const thumbCache = new Map<string, string>();

  // The map canvas only rebuilds when the map-related data has actually changed -- compared by
  // reference equality, not a deep comparison (../ui/controller.ts's #setState() always does a
  // shallow spread, so any nested field that wasn't explicitly changed keeps its original
  // reference). The right column (selection details) no longer needs to protect any input focus,
  // so it's rebuilt wholesale on every applyState(), see the file header -- this view now updates
  // far less often than the old version (nothing fires on every keystroke anymore), so it doesn't
  // need its own reference-equality throttling.
  let lastSpec: EditorState["spec"] | undefined;
  let lastReadiness: EditorState["readiness"] | undefined;
  let lastMediaSlugs: EditorState["mediaSlugs"] | undefined;
  let lastModel: StoryMapModel | undefined;
  /** Map interaction batch: remembers "the selected node the screen last applied" -- only calls
   * ensureNodeVisible() when the selection actually changes (not on every needless applyState()
   * pan). The initial value is `undefined` (not `null`), deliberately distinct from
   * `EditorState.mapSelection`'s `null` (no selection) -- so "this view was just mounted and
   * hasn't applied any selection yet" and "a selection of 'none' was already applied once" are two
   * different states -- the latter shouldn't trigger a pan, and neither should the former (there's
   * no reason to pan on initial mount); the two end up with the same result, but they're still
   * deliberately distinguished in meaning, not accidentally sharing one condition. */
  let lastMapSelection: string | null | undefined;

  const applyState = (state: EditorState) => {
    if (state.spec !== lastSpec || state.readiness !== lastReadiness || state.mediaSlugs !== lastMediaSlugs) {
      lastSpec = state.spec;
      lastReadiness = state.readiness;
      lastMediaSlugs = state.mediaSlugs;
      lastModel = computeStoryMap({ spec: state.spec, readiness: state.readiness, mediaSlugs: state.mediaSlugs });
    }
    const model = lastModel!;
    currentLayout = renderCanvas(canvasContainer, model, state.storySlug, state.mapSelection, controller, thumbCache);
    renderReadinessChips(chips, model, state.readiness, state.readinessLoading, controller);
    renderAside(aside, model, state, controller);

    tryInitialFit();

    // When a node is selected, pan it into view if it's not already visible -- only
    // triggered when the selection actually changes (see the lastMapSelection note above), not
    // repanning on every applyState().
    if (state.mapSelection !== lastMapSelection) {
      lastMapSelection = state.mapSelection;
      if (state.mapSelection !== null) {
        const node = model.nodes.find((n) => n.chapterSlug === state.mapSelection);
        const box = node ? currentLayout.nodeBoxes.get(node.id) : undefined;
        if (box && panzoom) ensureNodeVisible(panzoom, canvasWrap, box, currentLayout, chipRowTopInset(chips));
      }
    }
  };
  applyState(initial);

  return {
    element,
    update: applyState,
    dispose(): void {
      // thumbCache stores the return values of URL.createObjectURL() -- without revoking them,
      // every time "this map view instance" is unmounted, these object URLs become orphans that no
      // <img> can ever reference again but that still permanently occupy memory.
      for (const url of thumbCache.values()) URL.revokeObjectURL(url);
      thumbCache.clear();
      canvasWrap.removeEventListener("wheel", onWheel);
      disposed = true;
      panzoom?.destroy();
    },
  };
}
