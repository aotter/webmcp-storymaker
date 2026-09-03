// getStoryReadiness()'s reusable contract tests — the same set of
// behavioral assertions applied to any WorkspaceStoragePort implementation, mirroring
// what ./contract.ts does for the story operation layer's four functions. These
// tests run contract-style against both memory and IndexedDB — see the callers
// ../testing/memoryWorkspaceStorage.readiness.workspace.test.ts and
// ../adapters/indexeddbWorkspaceStorage.readiness.workspace.test.ts.
//
// The filename has no .test suffix, so vitest's file glob won't load it directly —
// only a real *.workspace.test.ts file that imports it and calls
// describeReadinessContract() registers its describe/it blocks (same reasoning as
// ./contract.ts's file header).
import { describe, expect, it } from "vitest";
import type { WorkspaceStoragePort } from "../ports.ts";
import { createMinimalStory } from "./createMinimalStory.ts";
import { readStory } from "./readStory.ts";
import { updateStoryStructure } from "./updateStoryStructure.ts";
import { getStoryReadiness } from "./readiness.ts";
import { DEFAULT_LANG, MINIMAL_STORY_NODE_ID } from "./types.ts";

/** RaceInjectingStorage (../testing/raceInjectingStorage.ts) is "inject a concurrent
 * mutate() on the Nth readFile() call" — great for readStory.ts's own torn-read
 * tests (it only calls readFile("story.yaml") once), but getStoryReadiness() calls
 * readFile() multiple times (once for story.yaml, plus once for media.json when
 * relevant), so pinning by "the Nth call" is too fragile and might accidentally hit
 * a path readStory() has already validated internally, testing nothing new that
 * this file actually needs to prove — the torn read between readStory() and reading
 * media.json (the three-way consistency described in the file header). This uses a
 * variant that instead "injects when a specific path is hit", precisely targeting
 * that one readFile() call for media.json. */
class RaceOnPathStorage implements WorkspaceStoragePort {
  #remaining: number;

  constructor(
    private readonly inner: WorkspaceStoragePort,
    private readonly targetPath: string,
    private readonly injectMutation: () => Promise<void>,
    maxInjections: number,
  ) {
    this.#remaining = maxInjections;
  }

  open(): Promise<void> {
    return this.inner.open();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  list(): ReturnType<WorkspaceStoragePort["list"]> {
    return this.inner.list();
  }
  mutate(mutation: Parameters<WorkspaceStoragePort["mutate"]>[0]): ReturnType<WorkspaceStoragePort["mutate"]> {
    return this.inner.mutate(mutation);
  }
  async readFile(path: string): ReturnType<WorkspaceStoragePort["readFile"]> {
    if (path === this.targetPath && this.#remaining > 0) {
      this.#remaining--;
      await this.injectMutation();
    }
    return this.inner.readFile(path);
  }
}

export function describeReadinessContract(name: string, makeStorage: () => WorkspaceStoragePort): void {
  describe(`getStoryReadiness — ${name}`, () => {
    async function openedStorage(): Promise<WorkspaceStoragePort> {
      const storage = makeStorage();
      await storage.open();
      return storage;
    }

    // ---- not-started / unreadable ----

    it("reports not-started on an empty workspace, not an error", async () => {
      const storage = await openedStorage();

      const result = await getStoryReadiness(storage);

      expect(result.status).toBe("not-started");
      expect(result.summary.length).toBeGreaterThan(0);
    });

    it("reports unreadable(invalid-yaml) for a syntactically broken story.yaml, not a throw", async () => {
      const storage = await openedStorage();
      const brokenYaml = "specVersion: storymaker/v1alpha1\nkind: [unterminated flow seq\n";
      const seed = await storage.mutate({ expectedRevision: 0, ops: [{ op: "write", path: "story.yaml", kind: "text", text: brokenYaml }] });
      expect(seed.ok).toBe(true);

      const result = await getStoryReadiness(storage);

      expect(result.status).toBe("unreadable");
      expect(result.status === "unreadable" ? result.reason.type : null).toBe("invalid-yaml");
    });

    // ---- Complete story: ready ----

    it('reports "ready" for a minimal story with non-empty content and no media references', async () => {
      const storage = await openedStorage();
      const seed = await createMinimalStory(storage, { slug: "ready-story", title: "Completed Story" });
      expect(seed.ok).toBe(true);

      const result = await getStoryReadiness(storage);

      expect(result.status).toBe("ready");
      if (result.status !== "ready" && result.status !== "incomplete") return;
      expect(result.diagnostics.errors).toEqual([]);
      expect(result.content.missing).toEqual([]);
      expect(result.media.missing).toEqual([]);
      expect(result.summary).toContain("is complete");
      expect(result.revision).toBe(seed.ok ? seed.revision : -1);
    });

    // ---- Content completeness ----

    it('reports missing content as "incomplete" with an accurate, human-readable summary', async () => {
      const storage = await openedStorage();
      await createMinimalStory(storage, { slug: "two-pages", title: "Page One" });
      const current = await readStory(storage);
      expect(current.ok).toBe(true);
      if (!current.ok) return;

      // Add a second node whose content ref points at a chapterSlug that "hasn't
      // been written yet" (without calling updatePageText, so the workspace has
      // no corresponding content/ file).
      const nextSpec = {
        ...current.spec,
        nodes: {
          ...current.spec.nodes,
          [MINIMAL_STORY_NODE_ID]: { ...current.spec.nodes[MINIMAL_STORY_NODE_ID], type: undefined, ending: undefined, next: "page-02" },
          "page-02": {
            type: "ending" as const,
            content: { $ref: "content://two-pages/chapters/page-02#fragments/text" },
            ending: { endingId: "page-02-ending", endingType: "good" as const },
          },
        },
      };
      const updated = await updateStoryStructure(storage, { expectedRevision: current.revision, spec: nextSpec });
      expect(updated.ok).toBe(true);

      const result = await getStoryReadiness(storage);

      expect(result.status).toBe("incomplete");
      if (result.status !== "incomplete") return;
      expect(result.content.totalReferenced).toBe(2);
      expect(result.content.missing).toEqual([{ chapterSlug: "page-02", reason: "missing-file" }]);
      expect(result.summary).toContain("1 page is still missing content");
      expect(result.summary).toContain("page-02");
    });

    // ---- StorySpec validate diagnostics ----

    it("splits validate() diagnostics into errors and warnings, and marks incomplete on any error", async () => {
      const storage = await openedStorage();
      const seed = await createMinimalStory(storage, { slug: "broken-spec", title: "Broken Story" });
      expect(seed.ok).toBe(true);
      if (!seed.ok) return;
      const current = await readStory(storage);
      expect(current.ok).toBe(true);
      if (!current.ok) return;

      // Write a story.yaml with a broken kind directly (bypassing
      // updateStoryStructure's validate gate — readiness's stance is "an invalid
      // story still gets reported", so we need a genuinely invalid story.yaml to
      // verify that).
      const brokenYaml = `specVersion: storymaker/v1alpha1\nkind: NotAStory\nmetadata:\n  slug: broken-spec\nstart: ${MINIMAL_STORY_NODE_ID}\nnodes:\n  ${MINIMAL_STORY_NODE_ID}:\n    type: ending\n    content: { $ref: "content://broken-spec/chapters/${MINIMAL_STORY_NODE_ID}#fragments/text" }\n    ending: { endingId: only-ending }\n`;
      const write = await storage.mutate({ expectedRevision: current.revision, ops: [{ op: "write", path: "story.yaml", kind: "text", text: brokenYaml }] });
      expect(write.ok).toBe(true);

      const result = await getStoryReadiness(storage);

      expect(result.status).toBe("incomplete");
      if (result.status !== "incomplete") return;
      expect(result.diagnostics.errors.length).toBeGreaterThan(0);
      expect(result.summary).toContain("error");
    });

    // ---- Media completeness ----

    it("reports missing media files referenced by media.json", async () => {
      const storage = await openedStorage();
      const seed = await createMinimalStory(storage, { slug: "media-gap", title: "Missing Media Story" });
      expect(seed.ok).toBe(true);
      if (!seed.ok) return;
      const mediaJson = JSON.stringify({ [MINIMAL_STORY_NODE_ID]: { file: `${MINIMAL_STORY_NODE_ID}.png` } });
      const write = await storage.mutate({ expectedRevision: seed.revision, ops: [{ op: "write", path: "media.json", kind: "text", text: mediaJson }] });
      expect(write.ok).toBe(true);

      const result = await getStoryReadiness(storage);

      expect(result.status).toBe("incomplete");
      if (result.status !== "incomplete") return;
      expect(result.media.missing).toEqual([`media/${MINIMAL_STORY_NODE_ID}.png`]);
      expect(result.media.unparsable).toBe(false);
      expect(result.summary).toContain("media file is missing");
    });

    it('reports "ready" once the referenced media file actually exists', async () => {
      const storage = await openedStorage();
      const seed = await createMinimalStory(storage, { slug: "media-complete", title: "Complete Media Story" });
      expect(seed.ok).toBe(true);
      if (!seed.ok) return;
      const mediaJson = JSON.stringify({ [MINIMAL_STORY_NODE_ID]: { file: `${MINIMAL_STORY_NODE_ID}.png` } });
      const write = await storage.mutate({
        expectedRevision: seed.revision,
        ops: [
          { op: "write", path: "media.json", kind: "text", text: mediaJson },
          { op: "write", path: `media/${MINIMAL_STORY_NODE_ID}.png`, kind: "blob", bytes: new Uint8Array([1, 2, 3]) },
        ],
      });
      expect(write.ok).toBe(true);

      const result = await getStoryReadiness(storage);

      expect(result.status).toBe("ready");
    });

    // ---- Proof of freshness: reflects mutations immediately, no cache residue ----

    it("reflects a mutation immediately on the next call — no caching, always re-reads the current workspace", async () => {
      const storage = await openedStorage();
      const seed = await createMinimalStory(storage, { slug: "live-check", title: "Live Check" });
      expect(seed.ok).toBe(true);
      if (!seed.ok) return;

      const before = await getStoryReadiness(storage);
      expect(before.status).toBe("ready");
      const beforeRevision = before.status === "ready" ? before.revision : -1;

      // Clear the only page's content directly against the underlying storage
      // (mutate() itself doesn't forbid empty-string text — that's a stricter rule
      // the updatePageText write API adds on its own, see the updatePageText.ts
      // file header; here we deliberately bypass it to produce a genuine "content
      // became empty" state change).
      const current = await storage.list();
      const cleared = await storage.mutate({
        expectedRevision: current.revision,
        ops: [{ op: "write", path: `content/${MINIMAL_STORY_NODE_ID}.${DEFAULT_LANG}.txt`, kind: "text", text: "" }],
      });
      expect(cleared.ok).toBe(true);
      if (!cleared.ok) return;

      // The same storage instance, called again immediately — with no "clear the
      // cache" action anywhere, to prove getStoryReadiness() itself has zero
      // caching: the previous call returned ready, this one must immediately
      // reflect the mutate() just above and become incomplete, rather than
      // returning a result remembered from the previous call.
      const after = await getStoryReadiness(storage);

      expect(after.status).toBe("incomplete");
      if (after.status !== "incomplete") return;
      expect(after.content.missing).toEqual([{ chapterSlug: MINIMAL_STORY_NODE_ID, reason: "empty" }]);
      expect(after.revision).toBe(cleared.revision);
      expect(after.revision).not.toBe(beforeRevision);
    });

    // ---- Race: consistency between readStory() and the media.json read (same family as #137/#138) ----

    it("recovers from a concurrent media.json update between readStory() and the media.json read, and never mixes stale/fresh state", async () => {
      const inner = await openedStorage();
      const seed = await createMinimalStory(inner, { slug: "race-readiness", title: "Race Live Check" });
      expect(seed.ok).toBe(true);
      if (!seed.ok) return;
      const seedMedia = await inner.mutate({
        expectedRevision: seed.revision,
        ops: [{ op: "write", path: "media.json", kind: "text", text: JSON.stringify({ [MINIMAL_STORY_NODE_ID]: { file: `${MINIMAL_STORY_NODE_ID}.png` } }) }],
      });
      expect(seedMedia.ok).toBe(true);
      if (!seedMedia.ok) return;

      // At the exact moment of the readFile("media.json") call, actually land a
      // concurrent write: add the page illustration — if getStoryReadiness()
      // reads the combination "old list (no illustration) paired with the new
      // media.json", a combination that never actually existed, it would
      // misjudge it as missing; it must retry the whole round and converge on
      // "new list + new media.json", a consistent state that genuinely existed.
      const wrapper = new RaceOnPathStorage(
        inner,
        "media.json",
        async () => {
          const current = await inner.list();
          const write = await inner.mutate({
            expectedRevision: current.revision,
            ops: [{ op: "write", path: `media/${MINIMAL_STORY_NODE_ID}.png`, kind: "blob", bytes: new Uint8Array([9, 9, 9]) }],
          });
          if (!write.ok) throw new Error("test-injected concurrent write failed: " + JSON.stringify(write.error));
        },
        1,
      );

      const result = await getStoryReadiness(wrapper);

      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(result.media.missing).toEqual([]);

      // The underlying workspace itself should also reflect this (test-injected)
      // write — readiness only reads, it never writes.
      const innerList = await inner.list();
      expect(innerList.entries.some((e) => e.path === `media/${MINIMAL_STORY_NODE_ID}.png`)).toBe(true);
    });

    it("gives up and returns unreadable(workspace-busy) when the workspace keeps changing during the media.json read", async () => {
      const inner = await openedStorage();
      const seed = await createMinimalStory(inner, { slug: "race-readiness-busy", title: "Race Retry Limit" });
      expect(seed.ok).toBe(true);
      if (!seed.ok) return;
      const seedMedia = await inner.mutate({
        expectedRevision: seed.revision,
        ops: [{ op: "write", path: "media.json", kind: "text", text: JSON.stringify({ [MINIMAL_STORY_NODE_ID]: { file: `${MINIMAL_STORY_NODE_ID}.png` } }) }],
      });
      expect(seedMedia.ok).toBe(true);

      let counter = 0;
      const wrapper = new RaceOnPathStorage(
        inner,
        "media.json",
        async () => {
          counter++;
          const current = await inner.list();
          const write = await inner.mutate({
            expectedRevision: current.revision,
            ops: [{ op: "write", path: `content/race-${counter}.en.txt`, kind: "text", text: `race ${counter}` }],
          });
          if (!write.ok) throw new Error("test-injected concurrent write failed: " + JSON.stringify(write.error));
        },
        Number.POSITIVE_INFINITY,
      );

      const result = await getStoryReadiness(wrapper);

      expect(result.status).toBe("unreadable");
      expect(result.status === "unreadable" ? result.reason.type : null).toBe("workspace-busy");
    });
  });
}
