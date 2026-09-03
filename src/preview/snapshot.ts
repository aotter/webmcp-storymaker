// The preview snapshot (PreviewSnapshot): the "currently readable story" shape shared by the
// creator's local preview and the phone-QR-scan preview.
//
// This is the only input PreviewReader knows how to read. Both data sources (the PreviewSource
// adapters) produce it:
//   - LocalSource: assembled by reading the IndexedDB workspace directly, in the same tab
//     (the creator's local preview).
//   - RelaySource: obtained from the creator's tab via relay (the phone-QR-scan preview);
//     relay only forwards it, never parses it.
// Image bytes are not stored inside the snapshot object (they can be several MiB); PreviewSource
// supplies them separately by imageId (LocalSource reads the blob directly; RelaySource
// reassembles it from received chunks).
//
// Scope (contest build): plain-text content + choice branching + at most one illustration per
// page. Choices carry no condition (StorySpec's condition is neither evaluated nor carried over
// when the snapshot is assembled - the contest build's stories have no conditional branching;
// this is a deliberate scope cut, not an omission; to add it later, add a condition field here
// and have the reader evaluate it with story-contract evaluate()).
//
// This file has only types + constants, zero dependencies, zero I/O; the runtime validation
// functions are each implemented fail-closed by their consumers (reader/relay), but they must
// treat the shapes here as the single authority.

export type PreviewImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface PreviewChoice {
  /** The choice text shown to the reader. */
  readonly label: string;
  /** The target page id (must exist in story.pages). */
  readonly target: string;
}

export interface PreviewPage {
  readonly id: string;
  /** The page title (optional; not shown if absent). */
  readonly title?: string;
  /** The page's plain-text content (already resolved from content/<page>.<lang>.txt; the
   * reader does not do any further reference resolution). */
  readonly text: string;
  /** The id of the illustration this page has adopted (matches images[].id); omitted if the
   * page has no illustration. */
  readonly imageId?: string;
  /** The branching choices; an empty array with an empty next -> this is an ending. */
  readonly choices: readonly PreviewChoice[];
  /** The next page id when there is no branch (linear progression); omitted on an ending
   * page. */
  readonly next?: string;
}

export interface PreviewStory {
  readonly title: string;
  readonly startPageId: string;
  readonly pages: readonly PreviewPage[];
}

export interface PreviewImageMeta {
  readonly id: string;
  readonly mime: PreviewImageMime;
  readonly byteLength: number;
}

export interface PreviewSnapshot {
  readonly story: PreviewStory;
  readonly images: readonly PreviewImageMeta[];
  /** The source workspace's revision (used to show "which version this is"; the reader does
   * not rely on its meaning otherwise). */
  readonly revision: number;
}

/** Snapshot caps (shared by both sides; relay has its own separate transport-layer caps, and
 * the stricter one wins). */
export const PREVIEW_LIMITS = Object.freeze({
  maxPages: 200,
  maxTextCharsPerPage: 5_000,
  maxChoicesPerPage: 8,
  maxLabelChars: 80,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalImageBytes: 20 * 1024 * 1024,
});
