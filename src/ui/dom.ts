// "Too thin to be worth testing" DOM bindings -- does
// exactly three things: paints ./controller.ts's getState() onto the screen, turns user
// interactions (clicks) into controller method calls, and subscribes to the controller's change
// events to redraw. No validation/business logic lives here at all (all of that is in
// controller.ts, already covered by vitest).
//
// The empty state is just the guidance card (see
// createGuidanceCard()) -- no "create it yourself" form (slug/title inputs + submit button) and
// no backup export/restore fields. This page has absolutely no textarea/input[type=text]/input[type=file]
// anywhere (the text used to display the WebMCP connection-status pill doesn't count as input);
// the only path that writes to the workspace is ../webmcp/tools/writeTools.ts (see
// docs/architecture.md "WebMCP is the only write path").
//
// Redraw strategy (existing discipline): tearing down and rebuilding the entire DOM tree on every
// controller state change would look simplest at first glance, but this file chooses "never rebuild
// the DOM for the same view kind (state.view), only update in place" -- mainly because the map view
// (../map/render.ts's createMapEditorView()) holds resources like a thumbnail cache that need to
// survive across redraws, see that file's header note on "update in place when the screen identity
// hasn't changed". The same applies to the mount shells for the editor view's "story map"/"phone
// preview" tabs: both are only built once **on entering the editor view**, and switching tabs only
// toggles `hidden`, never rebuilding or disposing (so the map view's thumbnail cache and the phone
// preview's HostSession are never needlessly thrown away just from switching tabs -- the
// HostSession lives on
// ../ui/controller.ts and doesn't end when the screen's tab is switched, see that file's header).
// The "preview reader" tab is the opposite -- PreviewReader is remounted
// every time you "enter the preview tab" (it needs to read the latest content, not reuse the
// snapshot from the last mount), and is disposed (revoking image object URLs, disposing the
// PreviewSource it holds) when leaving the preview tab.
import type { StoryUiController } from "./controller.ts";
import type { UiState } from "./state.ts";
import { el } from "./domHelpers.ts";
import { createMapEditorView, type MapEditorView } from "../map/render.ts";
// The creator side's "preview reader" tab -- mounts PreviewReader (../preview/reader.ts) in the
// main area; its data source is provided by controller.createPreviewSource() (dom.ts never touches
// storage directly, per the existing discipline in the file header).
import { mountPreviewReader, type PreviewReaderHandle } from "../preview/reader.ts";
import "../preview/reader.css";
// The creator side's "phone preview" tab (QR code + pairing code + manual approval) -- a pure state
// renderer, see the header of ../preview/hostPanel.ts: like the map view, it's "built once on
// entering the editor view, only update()'d afterward", never mounted/disposed by switching tabs
// (the HostSession's lifecycle is managed entirely by the controller -- this file holds and
// disposes none of the connection-related resources itself).
import { createMobilePreviewView, type MobilePreviewView } from "../preview/hostPanel.ts";

/** The top bar's WebMCP connection status -- measured once by ../main.ts (the composition root)
 * after app.start() completes, fixed for the whole page lifecycle, not redetected on every
 * render(). */
export interface WebMcpStatus {
  readonly available: boolean;
  readonly toolCount: number;
}

interface ViewRenderer {
  readonly element: HTMLElement;
  /** The caller guarantees this is only called while state.view still matches the view this
   * renderer was built for -- the renderer still defensively narrows once more internally
   * (`if (state.view !== "…") return`), rather than assuming call order is always correct. */
  update(state: UiState): void;
}

/** The mount shell for the editor view's three tabs "story map"/"preview reader"/"phone preview" --
 * both the map view (`MapEditorView`) and the phone preview view (`MobilePreviewView`) are built
 * only once **on entering the editor view**; switching tabs only toggles `hidden`, never rebuilding
 * or disposing; "preview reader" is the only tab that remounts PreviewReader every time it's
 * switched into (see the file header). */
interface EditorMount {
  readonly element: HTMLElement;
  readonly mapView: MapEditorView;
  readonly mapContainer: HTMLElement;
  readonly previewContainer: HTMLElement;
  readonly mobileView: MobilePreviewView;
  readonly mobileContainer: HTMLElement;
  /** The tab currently applied to the screen -- `null` means this mount was just built and no tab
   * has been applied yet. */
  activeTab: "map" | "preview" | "mobile" | null;
  livePreview: PreviewReaderHandle | null;
}

function buildEditorMount(initial: Extract<UiState, { view: "editor" }>, controller: StoryUiController): EditorMount {
  const element = el("div", "ll-editor-mount");
  const mapContainer = el("div", "ll-editor-tab-container");
  const previewContainer = el("div", "ll-editor-tab-container");
  const mobileContainer = el("div", "ll-editor-tab-container");
  element.appendChild(mapContainer);
  element.appendChild(previewContainer);
  element.appendChild(mobileContainer);

  const mapView = createMapEditorView(initial, controller);
  mapContainer.appendChild(mapView.element);

  // Like the map view, "built once on entering the editor view" --
  // construction itself never starts any HostSession (that waits until the user actually switches
  // to this tab, see the note on setActiveTab() in ../ui/controller.ts); this just gets the screen
  // shell ready.
  const mobileView = createMobilePreviewView(initial, controller);
  mobileContainer.appendChild(mobileView.element);

  return { element, mapView, mapContainer, previewContainer, mobileView, mobileContainer, activeTab: null, livePreview: null };
}

/** Runs on every render() call -- if the tab hasn't changed, it's just an in-place
 * `mapView.update(state)`/`mobileView.update(state)`; only when the tab actually changes does it
 * handle mounting/disposing the preview reader and toggling the three containers' `hidden`. The map
 * view and phone preview view both keep getting update()'d regardless of which tab is currently
 * shown -- this way, when the user switches back to that tab, the screen is already up to date and
 * doesn't flash stale content first (this matters especially for the phone preview tab: a pairing
 * request may arrive while the user is on a different tab, see the top-bar badge logic in
 * mountStoryUi() in ../ui/dom.ts). */
function applyEditorMount(mount: EditorMount, state: Extract<UiState, { view: "editor" }>, controller: StoryUiController): void {
  if (state.activeTab !== mount.activeTab) {
    if (mount.livePreview) {
      mount.livePreview.dispose();
      mount.livePreview = null;
    }
    mount.previewContainer.replaceChildren();
    if (state.activeTab === "preview") {
      // "Preview from this page" (../map/render.ts's renderDetailPanel()) may already have set a
      // starting page -- take it (cleared once applied, see the note on
      // ../ui/state.ts's EditorState.previewStartPageId).
      const startPageId = controller.consumePreviewStartPageId() ?? undefined;
      const reader = mountPreviewReader(controller.createPreviewSource(), { startPageId });
      mount.livePreview = reader;
      mount.previewContainer.replaceChildren(reader.element);
    }
    mount.mapContainer.hidden = state.activeTab !== "map";
    mount.previewContainer.hidden = state.activeTab !== "preview";
    mount.mobileContainer.hidden = state.activeTab !== "mobile";
    mount.activeTab = state.activeTab;
  }
  mount.mapView.update(state);
  mount.mobileView.update(state);
}

/** Only called when actually leaving the editor view (the view kind changes): disposes any
 * still-alive preview reader first, then disposes the map view itself. The phone preview view
 * doesn't need disposing -- it holds no connection-related resources at all (the HostSession's
 * lifecycle is managed entirely by ../ui/controller.ts, and by the time the editor view is actually
 * left, controller.hydrate() has already called end() itself, see that file's header). */
function disposeEditorMount(mount: EditorMount): void {
  mount.livePreview?.dispose();
  mount.mapView.dispose();
}

export function mountStoryUi(root: HTMLElement, controller: StoryUiController, webMcp: WebMcpStatus): void {
  root.replaceChildren();

  const shell = el("div", "ll-shell");
  const header = el("header", "ll-topbar");

  const brand = el("div", "ll-brand");
  const brandMark = el("div", "ll-brand-mark");
  brandMark.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5C4 4.7 4.7 4 5.5 4H12v16H5.5C4.7 20 4 19.3 4 18.5z"/><path d="M20 5.5C20 4.7 19.3 4 18.5 4H12v16h6.5c.8 0 1.5-.7 1.5-1.5z"/></svg>';
  brand.appendChild(brandMark);
  const brandText = el("div", "ll-brand-text");
  const titleEl = el("p", "ll-story-title", "StoryMaker");
  brandText.appendChild(titleEl);
  brand.appendChild(brandText);
  header.appendChild(brand);

  // The top-bar tabs under the editor view -- only this view has the concept of "map / preview /
  // phone preview" at all (loading/create/error have no existing story to preview); render() syncs
  // the hidden/active classes every time it runs, without tracking a separate duplicate state.
  const tabs = el("div", "ll-tabs");
  const mapTabButton = el("button", "ll-tab", "Story map") as HTMLButtonElement;
  mapTabButton.type = "button";
  mapTabButton.addEventListener("click", () => controller.setActiveTab("map"));
  const previewTabButton = el("button", "ll-tab", "Preview reader") as HTMLButtonElement;
  previewTabButton.type = "button";
  previewTabButton.addEventListener("click", () => controller.setActiveTab("preview"));
  // The "phone preview" tab pill -- `mobileTabBadge` is the small red dot that needs to stay
  // visible for a pairing request (pair-request) even while the user isn't on this tab (see inside
  // render(): shown whenever `mobilePreview?.phase === "confirm-pairing"`, regardless of which tab
  // is currently selected); dismissing the badge and switching into the tab is the only way to see
  // the real confirmation card -- following the "never block the map" principle, this never pops
  // up any screen-covering dialog while the user is on a different tab.
  const mobileTabButton = el("button", "ll-tab", "") as HTMLButtonElement;
  mobileTabButton.type = "button";
  mobileTabButton.appendChild(document.createTextNode("Phone preview"));
  const mobileTabBadge = el("span", "ll-tab-badge");
  mobileTabBadge.hidden = true;
  mobileTabButton.appendChild(mobileTabBadge);
  mobileTabButton.addEventListener("click", () => controller.setActiveTab("mobile"));
  tabs.appendChild(mapTabButton);
  tabs.appendChild(previewTabButton);
  tabs.appendChild(mobileTabButton);
  header.appendChild(tabs);

  const actions = el("div", "ll-topbar-actions");
  const refreshButton = el("button", "ll-icon-btn", "") as HTMLButtonElement;
  refreshButton.type = "button";
  refreshButton.title = "Refresh";
  refreshButton.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>';
  // Calls the existing hydrate flow, so after the agent writes via
  // WebMCP, one click shows it; no polling. This is the only refresh entry point, with no
  // setInterval/background polling anywhere.
  refreshButton.addEventListener("click", () => void controller.hydrate());
  actions.appendChild(refreshButton);

  // Delete story: the one human-only write action (see controller.deleteStory()). Native confirm()
  // is the whole safeguard -- no custom modal, no undo; the story is the creator's only copy.
  const deleteButton = el("button", "ll-icon-btn ll-icon-btn-danger", "") as HTMLButtonElement;
  deleteButton.type = "button";
  deleteButton.title = "Delete story";
  deleteButton.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  deleteButton.addEventListener("click", () => {
    if (!window.confirm("Delete this story? Every page and illustration in this workspace will be removed. This cannot be undone.")) return;
    void controller.deleteStory();
  });
  actions.appendChild(deleteButton);

  const pill = el(
    "span",
    `ll-status-pill${webMcp.available ? "" : " ll-status-pill-off"}`,
  );
  pill.appendChild(el("span", "ll-status-dot"));
  pill.appendChild(document.createTextNode(webMcp.available ? `AI assistant connected · ${webMcp.toolCount} tools available` : "AI assistant not connected"));
  actions.appendChild(pill);
  header.appendChild(actions);
  shell.appendChild(header);

  const main = el("main", "ll-main");
  shell.appendChild(main);
  root.appendChild(shell);

  type Current = { readonly kind: "editor"; readonly mount: EditorMount } | { readonly kind: Exclude<UiState["view"], "editor">; readonly renderer: ViewRenderer };
  let current: Current | null = null;

  const render = () => {
    const state = controller.getState();
    titleEl.textContent = state.view === "editor" ? (state.title ?? state.storySlug) : "StoryMaker";
    main.classList.toggle("ll-main-wide", state.view === "editor");

    tabs.hidden = state.view !== "editor";
    if (state.view === "editor") {
      mapTabButton.classList.toggle("ll-tab-on", state.activeTab === "map");
      previewTabButton.classList.toggle("ll-tab-on", state.activeTab === "preview");
      mobileTabButton.classList.toggle("ll-tab-on", state.activeTab === "mobile");
      // A pairing request needs to stay visible from any tab -- regardless of whether the user is
      // currently on the story map or preview reader tab, see the note where mobileTabButton is
      // built above.
      mobileTabBadge.hidden = state.mobilePreview?.phase !== "confirm-pairing";
    }

    if (state.view === "editor") {
      if (current?.kind === "editor") {
        applyEditorMount(current.mount, state, controller);
      } else {
        // Arriving from a different view kind (loading/create/error) -- there's no old EditorMount
        // that needs disposing.
        const mount = buildEditorMount(state, controller);
        applyEditorMount(mount, state, controller);
        main.replaceChildren(mount.element);
        current = { kind: "editor", mount };
      }
      return;
    }

    if (current?.kind === "editor") {
      // Actually leaving the editor view (not just switching tabs) -- see the note on
      // disposeEditorMount().
      disposeEditorMount(current.mount);
      current = null;
    }
    if (!current || current.kind !== state.view) {
      const renderer = createViewRenderer(state);
      main.replaceChildren(renderer.element);
      current = { kind: state.view, renderer };
    } else {
      current.renderer.update(state);
    }
  };

  controller.subscribe(render);
  render();
  void controller.hydrate();
}

function createViewRenderer(state: Exclude<UiState, { view: "editor" }>): ViewRenderer {
  switch (state.view) {
    case "loading":
      return createLoadingView();
    case "error":
      return createErrorView(state.message);
    case "create":
      return createEmptyView();
  }
}

function createLoadingView(): ViewRenderer {
  const element = el("div", "ll-stage");
  element.appendChild(el("p", "ll-loading", "Loading…"));
  return { element, update: () => {} };
}

function createErrorView(message: string): ViewRenderer {
  const element = el("div", "ll-stage");
  const card = el("div", "ll-card ll-error-card");
  const text = el("p", undefined, message);
  card.appendChild(text);
  element.appendChild(card);

  return {
    element,
    update(state) {
      if (state.view !== "error") return;
      text.textContent = state.message;
    },
  };
}

/** The empty state (no story yet) -- just one guidance card, with no manual story-creation form
 * or backup-restore fields anywhere: the only way for
 * the whole workspace to go from "no story at all" to "one story exists" is for the agent to call
 * create_story (../webmcp/tools/writeTools.ts). */
function createGuidanceCard(): HTMLElement {
  const card = el("div", "ll-card ll-guidance-card");

  const icon = el("div", "ll-guidance-icon");
  icon.innerHTML =
    '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5C4 4.7 4.7 4 5.5 4H12v16H5.5C4.7 20 4 19.3 4 18.5z"/><path d="M20 5.5C20 4.7 19.3 4 18.5 4H12v16h6.5c.8 0 1.5-.7 1.5-1.5z"/><path d="M9 8h1M9 11h1M9 14h1" stroke-width="1.3"/></svg>';
  card.appendChild(icon);

  card.appendChild(el("h1", "ll-guidance-title", "Ask your AI assistant to get started"));
  card.appendChild(
    el(
      "p",
      "ll-guidance-desc",
      "There's no story here yet. Open the sidebar and tell your AI assistant about the story you want for your kid — it will use its built-in tools to build the story structure, write the text, and generate the art for you.",
    ),
  );

  const bubble = el("div", "ll-say-bubble");
  bubble.appendChild(el("span", "ll-say-quote", "“"));
  bubble.appendChild(el("p", "ll-say-text", "Write me a bedtime story about a lost bunny, with two endings, illustrated in a warm watercolor style."));
  card.appendChild(bubble);

  const steps = el("div", "ll-steps");
  const stepTexts = [
    "Your AI assistant first builds the story's branching structure — the start, the choices, and how they lead to the endings; aim for about 5 pages, one branch, and two endings.",
    "Then it writes the text page by page, and adds art to each page.",
    "Once it's done, this page automatically shows the story map, so you can check it over and read it aloud to your kid.",
  ];
  stepTexts.forEach((text, i) => {
    const step = el("div", "ll-step");
    step.appendChild(el("span", "ll-step-num", String(i + 1)));
    step.appendChild(el("span", undefined, text));
    steps.appendChild(step);
  });
  card.appendChild(steps);

  return card;
}

function createEmptyView(): ViewRenderer {
  const element = el("div", "ll-stage");
  element.appendChild(createGuidanceCard());
  // The empty state has no fields at all (../ui/state.ts's EmptyState), so there's nothing to
  // update in place.
  return { element, update: () => {} };
}
