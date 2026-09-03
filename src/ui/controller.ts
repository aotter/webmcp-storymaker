// The UI controller -- the "testable pure state machine"
// half (following the existing discipline, see the layering explanation in ./dom.ts's/
// ../map/render.ts's headers).
//
// This page **never writes to the workspace itself** --
// every write happens through ../webmcp/tools/writeTools.ts, which has its own expectedRevision OCC
// check, and after a write succeeds, ../main.ts's onWorkspaceMutated hook calls hydrate() here so
// the screen catches up automatically (the agent writing via WebMCP triggers a controller
// re-hydrate).
//
// hydrate() reads "everything the map needs to draw" all at once -- spec, readiness, the set of
// chapterSlugs that have art, and every page's full text (../ui/state.ts's
// EditorState.pagePreviews). This means selecting a node on the map (openMapNode()) becomes a pure
// synchronous operation: no extra storage read needs to be issued, so unlike the old version there's
// no need for a generation counter to guard against "the user clicking through several different
// nodes in a row" -- all the data is already in `#state`, and there's no await outside of
// `setState()` that could go stale. The only asynchronous flow that still needs a generation guard
// is `hydrate()` itself: the agent may call several write tools in a row, each one triggering an
// `onWorkspaceMutated`, and an older hydrate() call that returns later shouldn't overwrite the
// result a newer one has already drawn -- `#hydrateGen` is exactly the generation guard needed here,
// with the plain semantics of "only the result of the most recent call counts".
import {
  DEFAULT_LANG,
  collectReferencedChapterSlugs,
  getStoryReadiness,
  parseMetaTitle,
  readStory,
  resolveChapterLang,
  type FocusController,
} from "../story/index.ts";
import type { WorkspaceStoragePort } from "../ports.ts";
import { MAX_MUTATION_OPS } from "../workspace/limits.ts";
import { formatReadStoryError } from "./messages.ts";
import type { EditorState, UiState } from "./state.ts";
import { LocalSource } from "../preview/localSource.ts";
import type { PreviewSource } from "../preview/source.ts";
import { HostSession, type HostSessionDeps, type HostSessionLike, type HostSessionState } from "../preview/hostSession.ts";

export interface StoryUiControllerDeps {
  readonly storage: WorkspaceStoragePort;
  readonly focus: FocusController;
  /** The "source of this tab" (`location.origin`) needed for the phone QR-code preview -- provided
   * once by the caller (../main.ts) at construction time (won't change within the same tab's
   * lifecycle); the controller itself never touches window/location, keeping the existing testing
   * discipline of "the controller has zero browser API access" (see the file header). */
  readonly viewerOrigin: string;
  /** The relay's connection address (`import.meta.env.VITE_PREVIEW_RELAY_URL`, read by ../main.ts
   * and passed in, for the same reason as `viewerOrigin`). `undefined` means this build has no relay
   * configured -- the "phone preview" tab always shows "no relay server address configured" and
   * never attempts to establish any HostSession (see `mobileRelayAvailable`). */
  readonly relayUrl: string | undefined;
  /** Constructs a new HostSession (or a test fake) -- when omitted, the real
   * ../preview/hostSession.ts `HostSession` is used. ../ui/controller.workspace.test.ts injects a
   * fake version to test behavior like "switching tabs doesn't end the session, only ending the
   * preview closes it", without needing to open a real WebSocket. */
  readonly createHostSession?: (deps: HostSessionDeps) => HostSessionLike;
}

export interface StoryUiController {
  getState(): UiState;
  /** Registers a "state changed" listener, and returns an unsubscribe function -- the DOM layer
   * relies on this to know when to redraw. */
  subscribe(listener: () => void): () => void;

  /** Reads the current workspace and decides whether to enter the create (empty state) or editor
   * view. Called once on mount; the "refresh" button and a successful WebMCP write by the agent
   * (see the file header) each run through the same equivalent logic again. */
  hydrate(): Promise<void>;
  /** Wipe the whole workspace (story.yaml, page text, art) and re-hydrate into the empty view.
   * Human-only destructive action: there is deliberately no WebMCP tool for this, so an agent can
   * never erase the creator's only copy on its own; ./dom.ts gates the click behind a native
   * confirm(). Motivated by an end-to-end test run where a fresh agent correctly refused to touch a
   * non-empty workspace and there was no way to start clean. */
  deleteStory(): Promise<void>;

  /** Clicking a map node -- opens the read-only details in the right column. Purely synchronous: the
   * data it needs (text, whether art exists) was already read in full during hydrate() (see the
   * file header), so no extra storage call is needed. */
  openMapNode(chapterSlug: string): void;
  closeMapNode(): void;

  /** Switching the top-bar tabs "story map / preview reader / phone preview" -- the first time it
   * switches to `"mobile"` and no HostSession has been started yet, one is automatically started
   * along with it (see `mobileRelayAvailable`/`#startMobilePreview()`). Switching to any other tab,
   * or switching back to the "phone preview" tab again, **never** affects an already-started
   * HostSession (unlike an earlier rule of "closing the
   * WS when leaving the preview tab"). */
  setActiveTab(tab: "map" | "preview" | "mobile"): void;
  /** The right column's "preview from this page" -- switches to the preview tab, and hands `nodeId`
   * to the next-mounted PreviewReader as its starting page (see the note on
   * ../ui/state.ts's EditorState.previewStartPageId). `nodeId` is ../map/model.ts's `MapNode.id`
   * (the story.yaml node id), not a chapterSlug -- PreviewPage.id uses the node id (see the header
   * of ../preview/buildPreviewSnapshot.ts). */
  previewFromNode(nodeId: string): void;
  /** Called once by dom.ts when it mounts the PreviewReader, to take the current
   * `previewStartPageId` and clear it back to `null` in place -- see that field's header note,
   * "cleared once applied". */
  consumePreviewStartPageId(): string | null;

  /** Builds a new LocalSource instance (for the creator side's local preview) -- every call is a new
   * instance; the caller (../ui/dom.ts) is responsible for calling the PreviewReader's dispose()
   * when leaving the preview tab, which in turn disposes of the source returned here (see the
   * dispose() semantics of mountPreviewReader() in ../preview/reader.ts). */
  createPreviewSource(): PreviewSource;

  /** Reads the current art bytes for a given mediaSlug -- shared by the map card thumbnail and the
   * right column's detail-panel art. Pure read, changes no state; returns `null` if the file can't
   * be found, and the caller decides on its own to show a "missing art" placeholder rather than this
   * function fabricating a blank image. */
  readAcceptedMedia(mediaSlug: string): Promise<{ readonly bytes: Uint8Array; readonly ext: string } | null>;

  /** Whether a relay address was configured at build time (`StoryUiControllerDeps.relayUrl`) --
   * fixed after construction, never changes for the controller's whole lifecycle. When `false`, the
   * "phone preview" tab only shows "no relay server address configured", and
   * `setActiveTab("mobile")` never attempts to start any HostSession. */
  readonly mobileRelayAvailable: boolean;
  /** The user presses "end preview" -- closes the current HostSession (if any), and resets
   * `EditorState.mobilePreview` back to `null`. If the user is **still** on the "phone preview" tab
   * when calling this method, a brand-new session is started immediately (following the same rule
   * as "starting one when entering this tab" -- the user is still on this tab, which most likely
   * means they want a new QR/pairing code to scan next, and the screen shouldn't get stuck showing
   * "connecting" with nothing to ever connect to); if the user isn't on this tab (e.g. the button is
   * only ever expected to appear on the phone preview tab, but this method doesn't assume the user
   * is necessarily still there when it's called), it simply ends, without auto-restarting. */
  endMobilePreview(): void;
  /** The user presses "allow" on the "confirm pairing" card -- only meaningful during the
   * confirm-pairing phase; a call during any other phase is a no-op (same existing guard as
   * HostSession.approve()). */
  approveMobilePairing(): void;
  /** The user presses "reject" on the "confirm pairing" card -- only meaningful during the
   * confirm-pairing phase (same existing guard as HostSession.reject()). */
  rejectMobilePairing(): void;
}

/** The path shape of `media/<chapterSlug>.<ext>` -- same as ../workspace/paths.ts's
 * MEDIA_FILE_PATTERN. The chapterSlug capture group is used by `listMediaSlugs()` to work backward
 * to the set of "chapterSlugs that have art". */
const MEDIA_FILE_RE = /^media\/([a-z0-9-]+)\.(?:png|jpg|jpeg|webp)$/;

/** Scans the workspace's file list directly and works backward to the set of chapterSlugs that
 * "currently have art" (see the note on ../ui/state.ts's EditorState.mediaSlugs). Whether a
 * chapterSlug has art is simply answered by whether the file
 * `media/<chapterSlug>.<ext>` exists. */
function listMediaSlugs(entries: readonly { readonly path: string; readonly kind: "text" | "blob" }[]): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "blob") continue;
    const match = MEDIA_FILE_RE.exec(entry.path);
    if (match) slugs.add(match[1]!);
  }
  return slugs;
}

class StoryUiControllerImpl implements StoryUiController {
  readonly #storage: WorkspaceStoragePort;
  readonly #focus: FocusController;
  readonly #viewerOrigin: string;
  readonly #relayUrl: string | undefined;
  readonly #createHostSession: (deps: HostSessionDeps) => HostSessionLike;
  readonly #listeners = new Set<() => void>();
  #state: UiState = { view: "loading" };
  /** See the file header -- only guards against "an older hydrate() call returning later". */
  #hydrateGen = 0;
  /** The phone QR-code preview. `null`
   * means no one has switched to the "phone preview" tab yet within this workspace's lifecycle.
   * Deliberately kept separate from `#state.mobilePreview` (the snapshot the screen sees): this
   * field is "the actually-alive HostSession object", while `#state.mobilePreview` is its
   * `getState()` result at some point in time -- the two are kept in sync via `onStateChange`, but
   * lifecycle is decided by this field, not the other way around. */
  #mobileSession: HostSessionLike | null = null;

  constructor(deps: StoryUiControllerDeps) {
    this.#storage = deps.storage;
    this.#focus = deps.focus;
    this.#viewerOrigin = deps.viewerOrigin;
    this.#relayUrl = deps.relayUrl;
    this.#createHostSession = deps.createHostSession ?? ((sessionDeps) => new HostSession(sessionDeps));
  }

  get mobileRelayAvailable(): boolean {
    return this.#relayUrl !== undefined;
  }

  getState(): UiState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #setState(next: UiState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  async hydrate(): Promise<void> {
    const gen = ++this.#hydrateGen;
    // Both the "refresh" button and the automatic hydrate after a successful agent write call this
    // method -- the user may currently be on the "preview reader" tab, or may have already selected
    // a node, and shouldn't be needlessly sent back to the "story map" tab or have their selection
    // cleared (partial continuity beats a full reset). This is the only point where "which tab is
    // active / which node is selected right now" can still be read -- `this.#state` is about to be
    // overwritten by `#setState({view: "loading"})` below.
    const previous =
      this.#state.view === "editor" ? { activeTab: this.#state.activeTab, mapSelection: this.#state.mapSelection } : { activeTab: "map" as const, mapSelection: null };
    this.#setState({ view: "loading" });

    const result = await readStory(this.#storage);
    if (gen !== this.#hydrateGen) return; // A stale result -- silently discarded (see the file header)
    if (!result.ok) {
      // Actually leaving the editor view (the story vanished, or the read itself errored) -- this
      // is one of the three triggers for end(), see the note above the
      // HostSession class in ../preview/hostSession.ts.
      this.#endMobileSession();
      if (result.error.type === "story-not-found") {
        this.#setState({ view: "create" });
        return;
      }
      this.#setState({ view: "error", message: formatReadStoryError(result.error) });
      return;
    }

    // Whether meta.json exists, or whether its content is valid JSON, doesn't affect whether the
    // story itself can be read (readStory() has already returned ok: true) -- this simply reads one
    // more piece of "display-only" data; failing to read it just means undefined, not treated as an
    // error.
    const metaFile = await this.#storage.readFile("meta.json");
    if (gen !== this.#hydrateGen) return;
    const title = parseMetaTitle(metaFile?.kind === "text" ? metaFile.text : undefined);

    const snapshot = await this.#storage.list();
    if (gen !== this.#hydrateGen) return;
    const mediaSlugs = listMediaSlugs(snapshot.entries);

    const chapterSlugs = [...collectReferencedChapterSlugs(result.spec)];
    const previewEntries = await Promise.all(
      chapterSlugs.map(async (chapterSlug) => {
        const lang = resolveChapterLang(snapshot.entries, chapterSlug, DEFAULT_LANG);
        const file = await this.#storage.readFile(`content/${chapterSlug}.${lang}.txt`);
        return [chapterSlug, file?.kind === "text" ? file.text : undefined] as const;
      }),
    );
    if (gen !== this.#hydrateGen) return;
    const pagePreviews = new Map<string, string>();
    for (const [chapterSlug, text] of previewEntries) {
      if (text !== undefined) pagePreviews.set(chapterSlug, text);
    }

    this.#setState({
      view: "editor",
      storySlug: result.spec.metadata.slug,
      title,
      revision: result.revision,
      readiness: null,
      readinessLoading: true,
      spec: result.spec,
      mediaSlugs,
      mapSelection: previous.mapSelection,
      pagePreviews,
      activeTab: previous.activeTab,
      previewStartPageId: null,
      // Carries forward the latest state of whatever HostSession is
      // actually alive right now (if any) -- this method may be called again after the user has
      // already started a phone preview (the refresh button, or an automatic hydrate triggered by an
      // agent write); the session itself isn't ended just because hydrate() ran, so the on-screen
      // snapshot needs to be updated along with it, not reset back to null.
      mobilePreview: this.#mobileSession?.getState() ?? null,
    });

    if (previous.mapSelection !== null) {
      // Where the person is currently looking -- an auxiliary hint, not story content (see the
      // header of ../story/focus.ts). Fire-and-forget: doesn't affect the screen (the data is
      // already in pagePreviews), and whether it succeeds or fails doesn't need to block anything.
      void this.#focus.setFocus({ storySlug: result.spec.metadata.slug, chapterSlug: previous.mapSelection, tab: "content" });
    }

    const readiness = await getStoryReadiness(this.#storage);
    if (gen !== this.#hydrateGen) return;
    if (this.#state.view !== "editor") return;
    this.#setState({ ...this.#state, readiness, readinessLoading: false });
  }

  async deleteStory(): Promise<void> {
    // Batches of MAX_MUTATION_OPS, each against the freshly listed revision (OCC), until empty.
    for (;;) {
      const snapshot = await this.#storage.list();
      if (snapshot.entries.length === 0) break;
      const ops = snapshot.entries.slice(0, MAX_MUTATION_OPS).map((entry) => ({ op: "delete" as const, path: entry.path }));
      const result = await this.#storage.mutate({ expectedRevision: snapshot.revision, ops });
      if (!result.ok) throw new Error(`deleteStory failed: `);
    }
    await this.hydrate();
  }

  openMapNode(chapterSlug: string): void {
    if (this.#state.view !== "editor") return;
    this.#setState({ ...this.#state, mapSelection: chapterSlug });
    // Where the person is currently looking -- an auxiliary hint, not story content
    // (../story/focus.ts). A fire-and-forget call inside a purely synchronous method: no on-screen
    // field depends on its result (the text is already in pagePreviews), and whether the call
    // succeeds or fails doesn't affect the rest of this method's behavior.
    void this.#focus.setFocus({ storySlug: this.#state.storySlug, chapterSlug, tab: "content" });
  }

  closeMapNode(): void {
    if (this.#state.view !== "editor") return;
    this.#setState({ ...this.#state, mapSelection: null });
  }

  setActiveTab(tab: "map" | "preview" | "mobile"): void {
    if (this.#state.view !== "editor") return;
    this.#setState({ ...this.#state, activeTab: tab });
    // The first time switching to the "phone preview" tab -- automatically start one (see the
    // method note on the interface). If one has already been started, `#mobileSession` isn't null,
    // and this is a plain no-op, never creating a second session.
    if (tab === "mobile") this.#startMobilePreview();
  }

  previewFromNode(nodeId: string): void {
    if (this.#state.view !== "editor") return;
    this.#setState({ ...this.#state, activeTab: "preview", previewStartPageId: nodeId });
  }

  consumePreviewStartPageId(): string | null {
    if (this.#state.view !== "editor") return null;
    const id = this.#state.previewStartPageId;
    if (id !== null) this.#setState({ ...this.#state, previewStartPageId: null });
    return id;
  }

  createPreviewSource(): PreviewSource {
    return new LocalSource(this.#storage);
  }

  async readAcceptedMedia(mediaSlug: string): Promise<{ readonly bytes: Uint8Array; readonly ext: string } | null> {
    if (this.#state.view !== "editor") return null;
    // mediaSlug is interpolated directly into a regex -- the safety here follows the existing
    // precedent of ../story/readiness.ts's computeContentGaps(): the caller (../map/render.ts) only
    // ever passes the `MapNode.chapterSlug` computed by ../map/model.ts as mediaSlug (mediaSlug ===
    // chapterSlug, see that file's header), and chapterSlug itself is already constrained by
    // ../story/refs.ts's CHAPTER_REF_RE to `^[a-z0-9-]+$`, a character set with no regex special
    // characters in it.
    const pattern = new RegExp(`^media/${mediaSlug}\\.(?:png|jpg|jpeg|webp)$`);
    const snapshot = await this.#storage.list();
    const entry = snapshot.entries.find((e) => e.kind === "blob" && pattern.test(e.path));
    if (!entry) return null;
    const file = await this.#storage.readFile(entry.path);
    if (file?.kind !== "blob") return null;
    const ext = entry.path.slice(entry.path.lastIndexOf(".") + 1);
    return { bytes: file.bytes, ext };
  }

  // ---- Phone QR-code preview -- see the
  // note above the HostSession class in ../preview/hostSession.ts: the instance lives on this
  // controller and doesn't end just because the tab was switched. ----

  /** Called the first time `setActiveTab("mobile")` switches to that tab -- idempotent: if
   * `#mobileSession` already exists (regardless of its current phase), this is skipped outright,
   * never creating a second connection; it's also skipped if relay isn't configured
   * (`!mobileRelayAvailable`), leaving `EditorState.mobilePreview` at `null` -- the display layer
   * (../preview/hostPanel.ts) shows its own fixed "not configured" copy based on
   * `mobileRelayAvailable` alone, and doesn't need to distinguish between the two different reasons
   * for `mobilePreview` being `null` by checking `mobilePreview` itself. */
  #startMobilePreview(): void {
    if (this.#state.view !== "editor") return;
    if (this.#mobileSession) return;
    if (!this.mobileRelayAvailable) return;

    const session = this.#createHostSession({
      relayUrl: this.#relayUrl!,
      source: this.createPreviewSource(),
      onStateChange: (state: HostSessionState) => {
        // A fire-and-forget asynchronous callback -- by the time it's called, the editor view may
        // already have been left (#endMobileSession() should already have cleared #mobileSession and
        // ended this session too, so no onStateChange call should be arriving at all, but this still
        // defensively guards against it once more rather than assuming call order is always
        // correct).
        if (this.#state.view !== "editor") return;
        this.#setState({ ...this.#state, mobilePreview: state });
      },
    });
    this.#mobileSession = session;
    this.#setState({ ...this.#state, mobilePreview: session.getState() });
    void session.start(this.#viewerOrigin);
  }

  /** All three end() triggers go through this private method (the other two are the callers in
   * hydrate()/main.ts): clears the `#mobileSession` reference, and only writes `mobilePreview` back
   * to `null` if still in the editor view right now -- when actually leaving the editor view, the
   * caller (hydrate()) is about to replace `#state` wholesale anyway, so there's no need, and it
   * would be wrong, to write one more patch here that's about to be overwritten immediately. */
  #endMobileSession(): void {
    if (!this.#mobileSession) return;
    this.#mobileSession.end();
    this.#mobileSession = null;
    if (this.#state.view === "editor") {
      this.#setState({ ...this.#state, mobilePreview: null });
    }
  }

  endMobilePreview(): void {
    this.#endMobileSession();
    // See the method note on the interface -- if the user is still on the "phone preview" tab, a
    // brand-new session is started immediately, instead of leaving behind a "connecting" placeholder
    // screen that will never resolve on its own.
    if (this.#state.view === "editor" && this.#state.activeTab === "mobile") {
      this.#startMobilePreview();
    }
  }

  approveMobilePairing(): void {
    this.#mobileSession?.approve();
  }

  rejectMobilePairing(): void {
    this.#mobileSession?.reject();
  }
}

export function createStoryUiController(deps: StoryUiControllerDeps): StoryUiController {
  return new StoryUiControllerImpl(deps);
}

// The EditorState/UiState types are used in this file's method signatures, and are re-exported so
// ./dom.ts / ../map/render.ts and tests can import them directly from here without going to
// ./state.ts separately (existing convention).
export type { EditorState, UiState } from "./state.ts";
