// focus — the UI/agent's "claim" about which story/page/tab it is
// currently looking at. This is not story-content truth (it is not written to the
// workspace, see the storage-location note under createFocusController below); it
// is "supporting context": the WebMCP tool `get_editor_focus`
// relies on it to answer "roughly where is the user/agent looking right now",
// giving the agent a conversational anchor — it is not meant to be used as the
// basis for any content-layer decision.
//
// State machine: claim -> validate -> adopt or
// drop:
//   1. setFocus(claim) validates against the "current workspace" fresh —
//      storySlug must equal the current story's metadata.slug, chapterSlug (if
//      given) must be a chapterSlug that story.yaml genuinely references right now
//      (the same logic ../story/updatePageText.ts uses to decide "does this page
//      not exist", reusing ./refs.ts's collectReferencedChapterSlugs rather than
//      defining a second standard for "page doesn't exist"), and tab (if given)
//      must be within the closed set FOCUS_TABS.
//   2. If any of these is invalid, the whole claim is dropped (never partially
//      adopted: for example, if storySlug is valid but tab is invalid, we never
//      "adopt just storySlug/chapterSlug and drop tab" — a claim is one atomic "here
//      is where I'm looking right now" assertion, and partial adoption would
//      produce a combination the claimant never actually claimed). Any existing
//      focus is left completely untouched — dropping a new claim does not revoke
//      the old valid state.
//   3. A drop must be "observable" (verbatim from the epic's acceptance criteria):
//      every drop (whether it happens at the moment of a setFocus() call, or is
//      discovered later when getFocus() revalidates and finds it stale) overwrites
//      lastRejectedClaim, so the caller can ask "what was the most recently
//      dropped claim, and why".
//   4. getFocus() revalidates before returning — the workspace may have changed
//      since setFocus() (a page got deleted, the story got swapped out, ...); a
//      focus that's gone stale is automatically downgraded to null and an
//      observable drop is recorded, rather than returning a stale focus that "was
//      valid when claimed, but no longer holds".
//
// tab is a closed set aligned with the editor's three tab concepts (structure
// graph / content / media) — this is not a finalized product decision, it is the
// minimal assumption made here so the rule "tab must be within a closed set" has
// something concrete to validate against. When the UI actually ships and needs
// more or fewer tabs, just change the FOCUS_TABS constant here (documented in the
// README).
//
// focus lives in a private field on the FocusController instance (app memory), it
// is never written to the workspace — it is "a page-level claim, validated by
// code, as supporting context", not story content (test #1 of the design: content
// goes into YAML, context is not content).
//
// Review fix (P1-B): setFocus()'s validateClaim() is asynchronous (it has to read
// the workspace), so the validation of two setFocus() calls can be in flight at
// the same time — the earlier one (A) hasn't come back yet, while the later one
// (B) finishes validating first and gets adopted; when A finally comes back late,
// the original code would simply do `this.#current = A`, overwriting the user's
// actual latest intent with a stale claim (last-intent-wins broken). This isn't
// just a UI-misleads-the-screen problem: `FocusController` itself is the sole data
// source for the WebMCP tool `get_editor_focus`, so the fault is
// at this layer, not something any caller can patch up by "checking afterward" —
// so the fix belongs right inside `StoryFocusController`, rather than relying on
// controller.ts to guard against it.
//
// Approach: a private `#generation` counter, incremented and captured when
// `setFocus()` starts (before `readStory()`; unrelated to whether validateClaim()
// itself needs to validate anything). After `validateClaim()`'s await returns, we
// first check whether generation is still the latest — if it isn't, this call has
// been overtaken by a newer setFocus() call: we don't write to `#current`
// (last-intent-wins — the newer claim has already decided, or is about to decide,
// what focus should be, and doesn't need this stale result to interfere), and we
// return a result explicitly marked as "stale, rejected not because the claim
// itself is invalid" (see the `superseded` member added to `FocusRejectionReason`
// below) — the caller (the future `get_editor_focus` tool, or any code observing
// setFocus()'s return value) can tell this call had no effect, without mistakenly
// thinking the claim itself was the problem.
//
// A `superseded` result does **not** get written into `lastRejectedClaim` (a
// deliberate design decision, reason below) — `lastRejectedClaim`'s existing meaning is
// "this claim is invalid for the current workspace" (story-slug-mismatch/
// chapter-not-found/...), a meaningful diagnostic signal: the caller might want to
// know "the user/agent just claimed a page that doesn't exist at all". `superseded`
// is purely a timing artifact of being overtaken by a newer call, and has nothing
// to do with whether the claim itself is valid — when a user rapidly switches
// between several pages, every "earlier call" becomes superseded, and if those
// were also recorded into `lastRejectedClaim`, this field would get washed out by
// a flood of benign race noise, drowning out the genuinely worth-reporting record
// of an invalid claim.
//
// Subsequent hardening (a tracking item left by the review, judged at the time as
// "does not block merge"): getFocus() itself also has an asynchronous
// revalidation (re-checking whether #current is still valid), the same shape of
// problem — "validation in flight, the world may have changed underneath it" — but
// the original code didn't mirror setFocus()'s generation mechanism. The race:
// getFocus() starts revalidating the old claim A (at that moment it is #current)
// -> while the revalidation is still in flight, a new setFocus(B) runs to
// completion and is successfully adopted, `#current` becomes B -> A's
// revalidation only comes back now, and if it happens to find A invalid (say A's
// page got deleted), the original code would simply do `this.#current = null` —
// what actually gets cleared is **B**, a current focus that was never found
// invalid, and lastRejectedClaim would also be mis-recorded as "B was dropped for
// the reason A became invalid".
//
// The fix mirrors setFocus()'s spirit, but doesn't need a second #generation
// counter: getFocus() captures a reference to the current `#current` object
// (`claimAtStart`) before starting revalidation — every write to `#current`
// (whether setFocus() adopting a claim or getFocus() downgrading to null) is a
// brand-new value, so a reference comparison alone is enough to detect "has
// #current already been swapped out by someone else during revalidation". After
// the await returns, if `this.#current !== claimAtStart`, the subject of this
// validation result is no longer the current focus — regardless of whether the
// result is valid or not, it has nothing to do with the current state, so we don't
// null out `#current`, and we don't write to `lastRejectedClaim` either (same
// reasoning as setFocus()'s superseded handling: that's "the result of a stale
// validation", not a diagnostic signal that "the current claim is invalid") —
// instead we re-run getFocus() against the actual current `#current` to give a
// correct answer, rather than forcing through a result that's already answering
// the wrong question.
import type { WorkspaceStoragePort } from "../ports.ts";
import { readStory } from "./readStory.ts";
import { collectReferencedChapterSlugs } from "./refs.ts";

/** The editor's closed set of tabs. structure = the story structure graph (nodes/choices);
 * content = content editing; media = illustration editing. */
export const FOCUS_TABS = ["structure", "content", "media"] as const;
export type FocusTab = (typeof FOCUS_TABS)[number];

function isFocusTab(value: string): value is FocusTab {
  return (FOCUS_TABS as readonly string[]).includes(value);
}

export interface FocusClaim {
  readonly storySlug: string;
  readonly chapterSlug?: string;
  readonly tab?: FocusTab;
}

/** A validated, currently-active focus — the same shape as FocusClaim (once
 * adopted, it's just the claim taken as-is); it has its own name purely to
 * distinguish "an unvalidated claim" from "a validated current state" at the type
 * level. */
export type Focus = FocusClaim;

export type FocusRejectionReason =
  | { readonly type: "story-unreadable"; readonly detail: string }
  | { readonly type: "story-slug-mismatch"; readonly claimed: string; readonly current: string }
  | { readonly type: "chapter-not-found"; readonly chapterSlug: string; readonly knownChapterSlugs: readonly string[] }
  | { readonly type: "invalid-tab"; readonly tab: string; readonly knownTabs: readonly FocusTab[] }
  // Review fix (P1-B): this setFocus() call was overtaken during validation by a
  // newer setFocus() call (see the file header above) — it's not that the claim
  // itself is invalid, it's simply stale by timing, and under last-intent-wins it
  // is not adopted. Unlike the other members, this reason is **not** written into
  // `lastRejectedClaim` (same reasoning as above).
  | { readonly type: "superseded"; readonly reason: string };

/** An observable drop record — verbatim from the epic's acceptance criteria: "a
 * fake story/page/tab is always dropped and observable". This doesn't distinguish
 * "rejected at the moment of setFocus()" from "found stale by getFocus()'s later
 * revalidation" — both cases share the same field: the caller only needs to look
 * at lastRejectedClaim in one place to ask "what was the most recently dropped
 * claim, and why", without having to track two separate paths. */
export interface RejectedFocusClaim {
  readonly claim: FocusClaim;
  readonly reason: FocusRejectionReason;
  /** A Date.now() timestamp — purely so a human/caller can judge "how fresh is
   * this drop record", it plays no part in any validation logic. */
  readonly rejectedAt: number;
}

export type SetFocusResult =
  | { readonly ok: true; readonly focus: Focus }
  | { readonly ok: false; readonly reason: FocusRejectionReason };

export interface FocusController {
  setFocus(claim: FocusClaim): Promise<SetFocusResult>;
  /** Revalidates the current focus (if any) before returning — the workspace may
   * have changed, and a focus that's gone stale is automatically downgraded to
   * null with an observable drop recorded (see lastRejectedClaim). */
  getFocus(): Promise<Focus | null>;
  /** The most recently dropped claim, the sole observation window into drop events
   * (see the type comment above). Is null when no claim has ever been dropped yet
   * (including the initial state right after this controller is created, before
   * setFocus/getFocus has been called). */
  readonly lastRejectedClaim: RejectedFocusClaim | null;
}

async function validateClaim(storage: WorkspaceStoragePort, claim: FocusClaim): Promise<{ ok: true } | { ok: false; reason: FocusRejectionReason }> {
  const storyResult = await readStory(storage);
  if (!storyResult.ok) {
    const detail =
      storyResult.error.type === "story-not-found"
        ? "the workspace doesn't have a story yet"
        : storyResult.error.type === "invalid-yaml"
          ? `the story file can't be read right now: ${storyResult.error.reason}`
          : storyResult.error.reason;
    return { ok: false, reason: { type: "story-unreadable", detail } };
  }

  if (storyResult.spec.metadata.slug !== claim.storySlug) {
    return {
      ok: false,
      reason: { type: "story-slug-mismatch", claimed: claim.storySlug, current: storyResult.spec.metadata.slug },
    };
  }

  if (claim.chapterSlug !== undefined) {
    // The same standard ../story/updatePageText.ts uses to decide whether a
    // chapterSlug exists (reusing collectReferencedChapterSlugs rather than
    // defining a second rule for "the page doesn't exist").
    const known = collectReferencedChapterSlugs(storyResult.spec);
    if (!known.has(claim.chapterSlug)) {
      return {
        ok: false,
        reason: { type: "chapter-not-found", chapterSlug: claim.chapterSlug, knownChapterSlugs: [...known].sort() },
      };
    }
  }

  if (claim.tab !== undefined && !isFocusTab(claim.tab)) {
    return { ok: false, reason: { type: "invalid-tab", tab: claim.tab, knownTabs: FOCUS_TABS } };
  }

  return { ok: true };
}

class StoryFocusController implements FocusController {
  #storage: WorkspaceStoragePort;
  #current: Focus | null = null;
  #lastRejectedClaim: RejectedFocusClaim | null = null;
  /** Claim generation (P1-B fix, see the file header) — incremented and captured on
   * every setFocus() call; if by the time validation returns it is no longer the
   * latest call, this result has been overtaken by a newer setFocus() call and is
   * not adopted. */
  #generation = 0;

  constructor(storage: WorkspaceStoragePort) {
    this.#storage = storage;
  }

  get lastRejectedClaim(): RejectedFocusClaim | null {
    return this.#lastRejectedClaim;
  }

  async setFocus(claim: FocusClaim): Promise<SetFocusResult> {
    const generation = ++this.#generation;
    const validation = await validateClaim(this.#storage, claim);

    if (generation !== this.#generation) {
      // A newer setFocus() call happened while this validation was still in
      // flight — last-intent-wins: regardless of whether this validateClaim()
      // result would otherwise have been valid, it's no longer eligible to adopt
      // or overwrite the existing focus (see the file header).
      return {
        ok: false,
        reason: { type: "superseded", reason: "a newer setFocus() call happened while this one was still validating; this result is stale" },
      };
    }

    if (!validation.ok) {
      this.#lastRejectedClaim = { claim, reason: validation.reason, rejectedAt: Date.now() };
      return { ok: false, reason: validation.reason };
    }
    // The whole claim is adopted as-is (never partially adopted) — see the state
    // machine described in the file header.
    this.#current = { storySlug: claim.storySlug, chapterSlug: claim.chapterSlug, tab: claim.tab };
    return { ok: true, focus: this.#current };
  }

  async getFocus(): Promise<Focus | null> {
    // The sibling problem to the P1-B fix (subsequent review hardening):
    // getFocus()'s own revalidation is also asynchronous (validateClaim() has to
    // read the workspace), so #current can get swapped out by a successful
    // setFocus() while this revalidation is in flight — capture "who is the
    // subject of this revalidation" (claimAtStart, an object reference, not a deep
    // comparison: every write to #current is a brand-new object, so a differing
    // reference means the world has changed hands), so that once the await
    // returns we can tell whether this validation result still counts.
    const claimAtStart = this.#current;
    if (!claimAtStart) return null;

    const validation = await validateClaim(this.#storage, claimAtStart);

    if (this.#current !== claimAtStart) {
      // While the revalidation was in flight, #current was already swapped out by
      // a newer setFocus() (or already downgraded to null by another getFocus()
      // revalidation) — claimAtStart is no longer the current focus, so this
      // validation result (valid or not) has nothing to do with the current state:
      // it can't be used to null out the current focus, and it can't be recorded
      // into lastRejectedClaim either (same reasoning as setFocus()'s superseded
      // handling, see the file header: that would mis-record "a stale
      // validation's failure" as the current focus's failure, possibly clearing
      // the wrong target). The current state needs its own revalidation, not this
      // stale result — just re-run against whatever #current actually is now.
      return this.getFocus();
    }

    if (!validation.ok) {
      // The existing focus has gone stale (the workspace changed: a page got
      // deleted, the story got swapped out, ...) — automatically downgraded to
      // null, with an observable drop recorded (see point 4 of the "state machine"
      // in the file header). The reference comparison above guarantees that
      // claimAtStart here is still genuinely the current #current, so we can't be
      // clearing the wrong target.
      this.#lastRejectedClaim = { claim: claimAtStart, reason: validation.reason, rejectedAt: Date.now() };
      this.#current = null;
      return null;
    }
    return claimAtStart;
  }
}

/** Assembles a FocusController bound to a specific storage — called by
 * ../app.ts's composition root, one controller per App instance (focus is
 * app-memory state, not a global singleton). */
export function createFocusController(storage: WorkspaceStoragePort): FocusController {
  return new StoryFocusController(storage);
}
