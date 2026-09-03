// createFocusController()'s reusable contract tests — the same set of
// behavioral assertions applied to any WorkspaceStoragePort implementation, mirroring
// what ./contract.ts / ./readiness.contract.ts do. focus itself is never written to
// the workspace (see the focus.ts file header), but the validation logic reads the
// workspace (readStory()), so it likewise needs to run once against each of the
// memory and IndexedDB storages, to prove the validation logic behaves consistently
// on both backends.
//
// The filename has no .test suffix, so vitest's file glob won't load it directly —
// only a real *.workspace.test.ts file that imports it and calls
// describeFocusContract() registers its describe/it blocks (same reasoning as
// ./contract.ts's file header).
import { describe, expect, it } from "vitest";
import type { WorkspaceStoragePort } from "../ports.ts";
import { GateableStorage } from "../testing/gateableStorage.ts";
import { createMinimalStory } from "./createMinimalStory.ts";
import { readStory } from "./readStory.ts";
import { updateStoryStructure } from "./updateStoryStructure.ts";
import { createFocusController } from "./focus.ts";
import { MINIMAL_STORY_NODE_ID } from "./types.ts";

export function describeFocusContract(name: string, makeStorage: () => WorkspaceStoragePort): void {
  describe(`focus (setFocus/getFocus) — ${name}`, () => {
    async function openedStorage(): Promise<WorkspaceStoragePort> {
      const storage = makeStorage();
      await storage.open();
      return storage;
    }

    async function seedStory(storage: WorkspaceStoragePort, slug = "demo") {
      const result = await createMinimalStory(storage, { slug, title: "Demo Story" });
      if (!result.ok) throw new Error("seed failed: " + JSON.stringify(result.error));
      return result;
    }

    // ---- Valid claims ----

    it("adopts a valid claim and getFocus() returns it back unchanged", async () => {
      const storage = await openedStorage();
      await seedStory(storage, "demo");
      const focus = createFocusController(storage);

      const result = await focus.setFocus({ storySlug: "demo", chapterSlug: MINIMAL_STORY_NODE_ID, tab: "content" });

      expect(result).toEqual({ ok: true, focus: { storySlug: "demo", chapterSlug: MINIMAL_STORY_NODE_ID, tab: "content" } });
      expect(await focus.getFocus()).toEqual({ storySlug: "demo", chapterSlug: MINIMAL_STORY_NODE_ID, tab: "content" });
      expect(focus.lastRejectedClaim).toBeNull();
    });

    it("adopts a claim with only storySlug (chapterSlug/tab both optional)", async () => {
      const storage = await openedStorage();
      await seedStory(storage, "demo");
      const focus = createFocusController(storage);

      const result = await focus.setFocus({ storySlug: "demo" });

      expect(result.ok).toBe(true);
      expect(await focus.getFocus()).toEqual({ storySlug: "demo", chapterSlug: undefined, tab: undefined });
    });

    // ---- Three invalid cases (storySlug / chapterSlug / tab): dropped + observable + existing focus unchanged ----

    it("drops a claim with a storySlug that does not match the current story, observably, without touching the existing focus", async () => {
      const storage = await openedStorage();
      await seedStory(storage, "demo");
      const focus = createFocusController(storage);
      const adopted = await focus.setFocus({ storySlug: "demo", tab: "structure" });
      expect(adopted.ok).toBe(true);

      const rejected = await focus.setFocus({ storySlug: "not-the-current-story" });

      expect(rejected.ok).toBe(false);
      expect(rejected.ok === false ? rejected.reason : null).toEqual({
        type: "story-slug-mismatch",
        claimed: "not-the-current-story",
        current: "demo",
      });
      // Observable: lastRejectedClaim records this dropped claim and its reason.
      expect(focus.lastRejectedClaim?.claim).toEqual({ storySlug: "not-the-current-story" });
      expect(focus.lastRejectedClaim?.reason).toEqual({ type: "story-slug-mismatch", claimed: "not-the-current-story", current: "demo" });
      // The existing valid focus is completely unaffected.
      expect(await focus.getFocus()).toEqual({ storySlug: "demo", chapterSlug: undefined, tab: "structure" });
    });

    it("drops a claim with a chapterSlug that story.yaml does not reference, observably, without touching the existing focus", async () => {
      const storage = await openedStorage();
      await seedStory(storage, "demo");
      const focus = createFocusController(storage);
      const adopted = await focus.setFocus({ storySlug: "demo" });
      expect(adopted.ok).toBe(true);

      const rejected = await focus.setFocus({ storySlug: "demo", chapterSlug: "no-such-page" });

      expect(rejected.ok).toBe(false);
      expect(rejected.ok === false ? rejected.reason : null).toEqual({
        type: "chapter-not-found",
        chapterSlug: "no-such-page",
        knownChapterSlugs: [MINIMAL_STORY_NODE_ID],
      });
      expect(focus.lastRejectedClaim?.reason).toEqual({
        type: "chapter-not-found",
        chapterSlug: "no-such-page",
        knownChapterSlugs: [MINIMAL_STORY_NODE_ID],
      });
      expect(await focus.getFocus()).toEqual({ storySlug: "demo", chapterSlug: undefined, tab: undefined });
    });

    it("drops a claim with a tab outside the closed set, observably, without touching the existing focus", async () => {
      const storage = await openedStorage();
      await seedStory(storage, "demo");
      const focus = createFocusController(storage);
      const adopted = await focus.setFocus({ storySlug: "demo", tab: "media" });
      expect(adopted.ok).toBe(true);

      const rejected = await focus.setFocus({ storySlug: "demo", tab: "not-a-real-tab" as never });

      expect(rejected.ok).toBe(false);
      expect(rejected.ok === false ? rejected.reason : null).toEqual({
        type: "invalid-tab",
        tab: "not-a-real-tab",
        knownTabs: ["structure", "content", "media"],
      });
      expect(focus.lastRejectedClaim?.reason).toEqual({
        type: "invalid-tab",
        tab: "not-a-real-tab",
        knownTabs: ["structure", "content", "media"],
      });
      expect(await focus.getFocus()).toEqual({ storySlug: "demo", chapterSlug: undefined, tab: "media" });
    });

    it("drops the whole claim atomically — a valid storySlug does not get partially adopted when tab is invalid", async () => {
      const storage = await openedStorage();
      await seedStory(storage, "demo");
      const focus = createFocusController(storage);

      const rejected = await focus.setFocus({ storySlug: "demo", chapterSlug: MINIMAL_STORY_NODE_ID, tab: "bogus" as never });

      expect(rejected.ok).toBe(false);
      // No focus was adopted at all — not "adopt just storySlug/chapterSlug and
      // drop tab".
      expect(await focus.getFocus()).toBeNull();
    });

    it("drops any claim when there is no story to focus into yet (story-not-found)", async () => {
      const storage = await openedStorage(); // empty workspace, createMinimalStory hasn't been called yet
      const focus = createFocusController(storage);

      const rejected = await focus.setFocus({ storySlug: "demo" });

      expect(rejected.ok).toBe(false);
      expect(rejected.ok === false ? rejected.reason.type : null).toBe("story-unreadable");
      expect(await focus.getFocus()).toBeNull();
    });

    // ---- getFocus() revalidates before returning: a workspace change invalidates the existing focus ----

    it("auto-clears an existing focus, observably, when its chapterSlug stops being referenced after a structure change", async () => {
      const storage = await openedStorage();
      const seed = await seedStory(storage, "demo");
      const focus = createFocusController(storage);
      const adopted = await focus.setFocus({ storySlug: "demo", chapterSlug: MINIMAL_STORY_NODE_ID, tab: "content" });
      expect(adopted.ok).toBe(true);
      expect(await focus.getFocus()).not.toBeNull();

      // Change the only node's content ref so MINIMAL_STORY_NODE_ID is no longer
      // referenced by any chapters ref — simulating what "the page got deleted"
      // does to focus (no need to actually delete the node; as soon as the
      // chapterSlug is no longer referenced, updatePageText/
      // collectReferencedChapterSlugs will judge it as not existing).
      const current = await readStory(storage);
      expect(current.ok).toBe(true);
      if (!current.ok) return;
      const renamed = {
        ...current.spec,
        nodes: {
          [MINIMAL_STORY_NODE_ID]: {
            ...current.spec.nodes[MINIMAL_STORY_NODE_ID],
            content: { $ref: "content://demo/chapters/renamed-page#fragments/text" },
          },
        },
      };
      const updated = await updateStoryStructure(storage, { expectedRevision: current.revision, spec: renamed });
      expect(updated.ok).toBe(true);
      void seed;

      const result = await focus.getFocus();

      expect(result).toBeNull();
      // Observable: an automatic downgrade also has to leave a lastRejectedClaim.
      expect(focus.lastRejectedClaim?.claim).toEqual({ storySlug: "demo", chapterSlug: MINIMAL_STORY_NODE_ID, tab: "content" });
      expect(focus.lastRejectedClaim?.reason).toEqual({
        type: "chapter-not-found",
        chapterSlug: MINIMAL_STORY_NODE_ID,
        knownChapterSlugs: ["renamed-page"],
      });
    });

    it("auto-clears an existing focus, observably, when the current story is swapped out (storySlug no longer matches)", async () => {
      const storage = await openedStorage();
      await seedStory(storage, "story-a");
      const focus = createFocusController(storage);
      const adopted = await focus.setFocus({ storySlug: "story-a" });
      expect(adopted.ok).toBe(true);

      // Replace the whole workspace with a different story (simulating "the story
      // got swapped" — per docs/architecture.md's single-story-per-workspace
      // model, swapping stories is equivalent to clearing and rebuilding).
      const list = await storage.list();
      const cleared = await storage.mutate({ expectedRevision: list.revision, ops: list.entries.map((e) => ({ op: "delete" as const, path: e.path })) });
      expect(cleared.ok).toBe(true);
      if (!cleared.ok) return;
      await createMinimalStory(storage, { slug: "story-b", title: "Swapped Story" });

      const result = await focus.getFocus();

      expect(result).toBeNull();
      expect(focus.lastRejectedClaim?.reason).toEqual({ type: "story-slug-mismatch", claimed: "story-a", current: "story-b" });
    });

    it("getFocus() returns null (not a throw) when there is no focus set yet", async () => {
      const storage = await openedStorage();
      await seedStory(storage, "demo");
      const focus = createFocusController(storage);

      expect(await focus.getFocus()).toBeNull();
      expect(focus.lastRejectedClaim).toBeNull();
    });

    // ---- Claim generation (P1-B fix, review): last-intent-wins under a race ----

    it("a setFocus() claim (A) whose validation is still in flight does not overwrite a newer setFocus() claim (B) that already landed", async () => {
      const storage = new GateableStorage(makeStorage());
      await storage.open();
      await seedStory(storage, "demo");
      const focus = createFocusController(storage);

      // A's validation is gated right before the first storage call inside
      // validateClaim()'s readStory() (list()).
      const releaseList = storage.gateNextCall("list");
      const claimA = { storySlug: "demo", tab: "structure" as const };
      const setAPromise = focus.setFocus(claimA);

      // B is unaffected by this gate (the gate is one-shot, already consumed by
      // A's call) — it runs to completion and is successfully adopted.
      const claimB = { storySlug: "demo", tab: "content" as const };
      const setB = await focus.setFocus(claimB);
      expect(setB).toEqual({ ok: true, focus: { storySlug: "demo", chapterSlug: undefined, tab: "content" } });

      releaseList();
      const setA = await setAPromise;

      // A gets back a "stale, not a successful adoption" result — it isn't lumped
      // together with an ordinary invalid claim.
      expect(setA.ok).toBe(false);
      expect(setA.ok === false ? setA.reason : null).toEqual({
        type: "superseded",
        reason: "a newer setFocus() call happened while this one was still validating; this result is stale",
      });

      // last-intent-wins: the current focus is still B, not overwritten by the
      // late-arriving A.
      expect(await focus.getFocus()).toEqual({ storySlug: "demo", chapterSlug: undefined, tab: "content" });

      // superseded is not recorded into lastRejectedClaim (see the design note and its
      // reasoning in the focus.ts file header) — no claim here was dropped for
      // being "invalid", so lastRejectedClaim should remain the initial null.
      expect(focus.lastRejectedClaim).toBeNull();
    });

    // ---- getFocus()'s own revalidation has a race too (subsequent review hardening, see
    // the "Subsequent hardening" note in the focus.ts file header) ----

    it("a getFocus() revalidation of a stale current focus (A) does not clobber a newer setFocus() claim (B) that landed mid-flight, even when A's revalidation turns out to fail", async () => {
      const storage = new GateableStorage(makeStorage());
      await storage.open();
      await seedStory(storage, "demo");
      const focus = createFocusController(storage);

      // A is first legitimately adopted, becoming #current.
      const adoptedA = await focus.setFocus({ storySlug: "demo", chapterSlug: MINIMAL_STORY_NODE_ID, tab: "content" });
      expect(adoptedA.ok).toBe(true);

      // getFocus() starts revalidating A, gated right before validateClaim() ->
      // readStory()'s first storage call (list()).
      const releaseList = storage.gateNextCall("list");
      const getFocusPromise = focus.getFocus();

      // While A's revalidation hasn't come back yet, B is unaffected by this gate
      // (the gate is one-shot, already consumed by A's call) — it runs to
      // completion and is successfully adopted, #current becomes B.
      const adoptedB = await focus.setFocus({ storySlug: "demo", tab: "structure" });
      expect(adoptedB).toEqual({ ok: true, focus: { storySlug: "demo", chapterSlug: undefined, tab: "structure" } });

      // Make A's revalidation destined to fail: change the content ref referenced
      // by A's chapterSlug (MINIMAL_STORY_NODE_ID) so it's no longer referenced by
      // any chapters — simulating "A's page has already been deleted" (B doesn't
      // specify a chapterSlug, so it's unaffected by this structural change and
      // still revalidates successfully).
      const current = await readStory(storage);
      expect(current.ok).toBe(true);
      if (!current.ok) return;
      const renamed = {
        ...current.spec,
        nodes: {
          [MINIMAL_STORY_NODE_ID]: {
            ...current.spec.nodes[MINIMAL_STORY_NODE_ID],
            content: { $ref: "content://demo/chapters/renamed-page#fragments/text" },
          },
        },
      };
      const updated = await updateStoryStructure(storage, { expectedRevision: current.revision, spec: renamed });
      expect(updated.ok).toBe(true);

      // Release A's revalidation — only now does it actually run, and it will be
      // judged a failure (chapter-not-found).
      releaseList();
      const result = await getFocusPromise;

      // A's stale revalidation result (failed or not) has nothing to do with the
      // current B: getFocus() returns B, not null.
      expect(result).toEqual({ storySlug: "demo", chapterSlug: undefined, tab: "structure" });
      // #current wasn't wrongly cleared — checking again afterward, B is still the
      // current focus.
      expect(await focus.getFocus()).toEqual({ storySlug: "demo", chapterSlug: undefined, tab: "structure" });
      // lastRejectedClaim wasn't polluted by A's stale-and-failed revalidation
      // this time — B was never found invalid, and A's failure has nothing to do
      // with the current state, so it shouldn't be recorded here.
      expect(focus.lastRejectedClaim).toBeNull();
    });
  });
}
