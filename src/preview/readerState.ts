// PreviewReader's "which page am I currently on" state - pure
// functions, zero DOM. Follows the existing layering discipline of ../ui/state.ts +
// ../ui/controller.ts: "testable pure state transitions" are kept separate from "DOM binding
// too thin to be worth testing" (./reader.ts); this file has zero DOM API, zero I/O, and only
// computes "what the next reading position should be."
//
// "Previous page" = popping the visited stack, not walking a reverse edge through the story -
// PreviewStory only defines the one-directional "move forward" relationships next/choices (see
// the ../preview/snapshot.ts header), with no reverse information at all; the same target page
// might also be pointed to by two different choices at once, so the concept of "the
// structurally unique previous page" simply doesn't hold in a story with branches. "Previous
// page" can therefore only honestly mean "go back to wherever I just came from," and the most
// direct way to implement that is a stack of visit order.
//
// Reading state lives only in memory - the state here is the entirety of
// "which page am I on + how do I go back," with no persistence at all; it disappears when the
// reader unmounts, and a refresh/re-scan always restarts from startPageId
// (initReaderState()/restart() are the same function, see below).
import type { PreviewPage, PreviewStory } from "./snapshot.ts";

export interface ReaderState {
  /** A stack of visited page ids, in visit order; the last one is the current page. Its length
   * is always >= 1 (startPageId is pushed in at construction). */
  readonly path: readonly string[];
}

/** The initial reading state, starting from the story's start page (or a given `startPageId`
 * override) - `restart()` is the same function, called with the second argument omitted
 * (going back to the beginning semantically means "reinitialize, back to the story's real
 * start," not "reinitialize to whatever page was specified last time"), so it isn't
 * reimplemented separately.
 *
 * The second argument is the
 * start-page override used by the right-column "preview from this page" feature
 * (../map/render.ts) - `overrideStartPageId` is only adopted if it actually exists in
 * `story.pages`; if it doesn't (e.g. the story's structure was changed by an agent between the
 * user pressing the button and the mount finishing, and the target page got removed), this
 * always fail-closed falls back to `story.startPageId`, rather than letting `currentPage()`
 * fail to find a page. */
export function initReaderState(story: PreviewStory, overrideStartPageId?: string): ReaderState {
  const startPageId = overrideStartPageId !== undefined && story.pages.some((p) => p.id === overrideStartPageId) ? overrideStartPageId : story.startPageId;
  return { path: [startPageId] };
}

export const restart = initReaderState;

export function currentPageId(state: ReaderState): string {
  return state.path[state.path.length - 1]!;
}

/** The current page's full content - returns `undefined` when `story.pages` has no matching id
 * (in theory this should never happen: `goTo()`'s callers only ever pass an id already
 * validated by buildPreviewSnapshot() and guaranteed to exist in `story.pages`, see
 * ./reader.ts); it's up to the caller to decide how to fail-closed. */
export function currentPage(state: ReaderState, story: PreviewStory): PreviewPage | undefined {
  return story.pages.find((p) => p.id === currentPageId(state));
}

export function canGoBack(state: ReaderState): boolean {
  return state.path.length > 1;
}

export function goBack(state: ReaderState): ReaderState {
  if (!canGoBack(state)) return state;
  return { path: state.path.slice(0, -1) };
}

/** Advances to `targetPageId` (a linear `next`, or some choice's `target`) - pushes it onto the
 * stack for `goBack()` to use later. This is an internal navigation action (the caller already
 * holds a valid page id; it isn't external input), so this doesn't re-validate whether
 * `targetPageId` exists in the story; the caller (./reader.ts) guarantees it only ever passes a
 * valid value. */
export function goTo(state: ReaderState, targetPageId: string): ReaderState {
  return { path: [...state.path, targetPageId] };
}
