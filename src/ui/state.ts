// The pure state types for the UI layer.
//
// This is the state half of the "testable pure function/controller" vs. "thin DOM binding" layering
// (existing discipline, see the header of ./controller.ts): ./controller.ts only operates on values
// of this type (a discriminated union, following the same result-union style as
// ../story/types.ts and ../workspace/types.ts), and knows nothing about and never touches any DOM
// API; ./dom.ts only reads values of this type to paint the screen and turns user interactions into
// controller method calls, doing no validation/business logic of its own.
//
// There is no editing state here (no form inputs, no draft text): every field is read by some
// piece of UI. The editor view is pure
// reading plus a small amount of on-screen focus state (which node is selected, which tab); every
// actual write happens through WebMCP (../webmcp/tools/writeTools.ts), entirely outside the UI's
// awareness -- after a write succeeds, ../main.ts's onWorkspaceMutated hook triggers
// controller.hydrate() to refresh automatically, so the UI doesn't need to, and shouldn't, hold any
// "currently being edited" draft state anymore.
//
// State machine (the view state machine: empty state / editing):
//   loading  -- just mounted, hasn't read the current workspace state yet (hydrate() in progress).
//   create   -- the workspace has no story (readStory returns story-not-found): shows the "ask your
//               AI assistant to get started" guidance card, with no manual story-creation path at
//               all (the view name keeps the existing literal "create" to reduce unnecessary
//               renaming blast radius -- semantically this is the "empty state", not a "creation
//               form").
//   editor   -- the workspace has a story: the story map + read-only readiness/selected-node
//               details + preview reader.
//   error    -- story.yaml itself is corrupted, or the workspace stayed busy until retries ran out
//               (invalid-yaml/workspace-busy) -- a read-layer problem, a different state from "the
//               story hasn't been created yet", and it can't be silently folded into the create view
//               (that would make the user think they can safely wait for the AI to create a new
//               story, papering over data that's corrupted but might still be recoverable).
import type { StoryReadiness } from "../story/index.ts";
import type { StorySpec } from "../contract/types.ts";
import type { HostSessionState } from "../preview/hostSession.ts";

export interface LoadingState {
  readonly view: "loading";
}

export interface ErrorState {
  readonly view: "error";
  readonly message: string;
}

/** The empty state -- no story yet, showing only the guidance card (see
 * ./dom.ts's createGuidanceCard()). No fields at all: this view no longer has a form to type into;
 * it's purely a static screen. */
export interface EmptyState {
  readonly view: "create";
}

export interface EditorState {
  readonly view: "editor";
  readonly storySlug: string;
  /** `meta.json`'s book title (../story/meta.ts's parseMetaTitle()) -- used for the top-bar display.
   * `undefined` means `meta.json` doesn't exist, or exists but has no valid `title` field; the
   * screen falls back to displaying `storySlug`, never leaving the title blank. */
  readonly title: string | undefined;
  /** The currently known workspace revision -- display-only (../map/render.ts doesn't need it to
   * read art, see the note on ./controller.ts's readAcceptedMedia()); updated after every
   * hydrate(). */
  readonly revision: number;
  readonly readiness: StoryReadiness | null;
  readonly readinessLoading: boolean;
  /** The workspace's current full StorySpec (../contract/types.ts) -- the map needs the real node
   * graph (`nodes`/`next`/`choices`). This is the same spec hydrate() has already read, not a
   * separate independent read path. */
  readonly spec: StorySpec;
  /** The set of chapterSlugs in the current workspace that "have art" -- comes from a single file-
   * list scan for `media/<chapterSlug>.<ext>` (`listMediaSlugs()` inside ../ui/controller.ts's
   * hydrate()) -- a page's art is simply whatever file currently exists at that path.
   * ../map/model.ts's `computeStoryMap()` uses it to determine each node's `mediaStatus`. */
  readonly mediaSlugs: ReadonlySet<string>;
  /** The node currently selected on the map, whose details show in the right column -- corresponds
   * to ../map/model.ts's `MapNode.chapterSlug` (not the node id). `null` means no node is selected,
   * and the right column only shows readiness. */
  readonly mapSelection: string | null;
  /** For every chapterSlug that "has resolvable text", maps to its currently landed full text --
   * hydrate() reads every page story.yaml references in one pass
   * (../story/refs.ts's collectReferencedChapterSlugs()), rather than fetching it on demand only
   * when a node is selected. The map card's "first few characters of text" summary and the right
   * column's full-text details share this same data, without reading it twice -- selecting a node
   * is therefore a purely synchronous operation (see ./controller.ts's openMapNode()), needing no
   * asynchronous generation guard. A chapterSlug missing from this map means that page has no text
   * yet (corresponds to a content gap in ../story/readiness.ts). */
  readonly pagePreviews: ReadonlyMap<string, string>;
  /** Which of the top bar's "story map / preview reader / phone preview" tabs is currently
   * selected. */
  readonly activeTab: "map" | "preview" | "mobile";
  /** The phone QR-code preview's connection state -- `null` means no one has switched to the "phone
   * preview" tab yet within this workspace's lifecycle (no HostSession has ever been started). Once
   * it has a value, it stays alive along with the HostSession instance until ./controller.ts decides
   * to end it (see that file's header) -- it is **not** cleared just from
   * switching to the "story map"/"preview reader" tab (unlike an earlier rule of "closing the
   * WS when leaving the preview tab"). When
   * `phase === "confirm-pairing"`, the top bar's tab pill must show its badge regardless of which
   * tab the user is currently on (see ../ui/dom.ts). */
  readonly mobilePreview: HostSessionState | null;
  /** When the right column's "preview from this page" button is pressed, the starting page id to
   * hand to the next-mounted PreviewReader (../map/model.ts's `MapNode.id`, not a chapterSlug --
   * PreviewPage.id uses the node id, see the "page id" note in the header of
   * ../preview/buildPreviewSnapshot.ts). `dom.ts` applies it once (reading it out when mounting
   * PreviewReader) and then clears it back to `null` in place -- not persistent state: switching
   * tabs again or refreshing should always start from the story's beginning, never accidentally
   * reusing the previous starting page. */
  readonly previewStartPageId: string | null;
}

export type UiState = LoadingState | ErrorState | EmptyState | EditorState;
