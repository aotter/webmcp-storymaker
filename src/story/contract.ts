// The story operation layer's (createMinimalStory/readStory/
// updateStoryStructure/updatePageText) reusable contract tests — the same set of
// behavioral assertions applied to any WorkspaceStoragePort implementation,
// mirroring what ../workspace/contract.ts does for WorkspaceStoragePort itself.
// Story-layer tests run under test:workspace, contract-style against both memory
// and IndexedDB — see the callers
// ../testing/memoryWorkspaceStorage.story.workspace.test.ts and
// ../adapters/indexeddbWorkspaceStorage.story.workspace.test.ts.
//
// The filename has no .test suffix, so vitest's file glob won't load it directly —
// only a real *.workspace.test.ts file that imports it and calls
// describeStoryContract() registers its describe/it blocks (same reasoning as
// ../workspace/contract.ts's file header).
//
// Every rejection case additionally verifies "the workspace's fingerprint is
// unchanged" (the list() snapshot plus every existing file's contents are
// unchanged) — fail-closed isn't just verifying "ok:false was returned", it's
// verifying "truly nothing happened".
import { describe, expect, it } from "vitest";
import type { StorySpec } from "../contract/types.ts";
import type { WorkspaceStoragePort } from "../ports.ts";
import type { WorkspaceSnapshot } from "../workspace/types.ts";
import { MAX_TEXT_FILE_BYTES } from "../workspace/limits.ts";
// The review fix (P1)'s torn-read test reuses ../testing/raceInjectingStorage.ts's
// RaceInjectingStorage (a wrapper written during the review fix), instead of
// rewriting a second copy of "inject a concurrent mutate() at the moment of a
// readFile() call".
import { RaceInjectingStorage } from "../testing/raceInjectingStorage.ts";
import { createMinimalStory } from "./createMinimalStory.ts";
import { readStory } from "./readStory.ts";
import { updateStoryStructure } from "./updateStoryStructure.ts";
import { updatePageText } from "./updatePageText.ts";
import { DEFAULT_LANG, MINIMAL_STORY_NODE_ID } from "./types.ts";

interface WorkspaceFingerprint {
  readonly list: WorkspaceSnapshot;
  readonly files: ReadonlyArray<readonly [string, unknown]>;
}

async function fingerprint(storage: WorkspaceStoragePort): Promise<WorkspaceFingerprint> {
  const list = await storage.list();
  const files = await Promise.all(list.entries.map(async (e) => [e.path, await storage.readFile(e.path)] as const));
  return { list, files };
}

export function describeStoryContract(name: string, makeStorage: () => WorkspaceStoragePort): void {
  describe(`story operations — ${name}`, () => {
    async function openedStorage(): Promise<WorkspaceStoragePort> {
      const storage = makeStorage();
      await storage.open();
      return storage;
    }

    async function createSeedStory(storage: WorkspaceStoragePort, overrides: Partial<{ slug: string; title: string }> = {}) {
      const result = await createMinimalStory(storage, { slug: overrides.slug ?? "demo", title: overrides.title ?? "Demo Story" });
      if (!result.ok) throw new Error("seed failed: " + JSON.stringify(result.error));
      return result;
    }

    // ---- createMinimalStory ----

    it("builds a zero-error minimal StorySpec from an empty workspace, with meta.json and a matching content fragment", async () => {
      const storage = await openedStorage();

      const result = await createMinimalStory(storage, { slug: "the-nutcracker", title: "Nutcracker" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.revision).toBe(1);

      const read = await readStory(storage);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(read.spec.metadata.slug).toBe("the-nutcracker");
      expect(read.spec.start).toBe(MINIMAL_STORY_NODE_ID);
      expect(Object.keys(read.spec.nodes)).toEqual([MINIMAL_STORY_NODE_ID]);
      expect(read.spec.nodes[MINIMAL_STORY_NODE_ID].type).toBe("ending");

      const meta = await storage.readFile("meta.json");
      expect(meta?.kind).toBe("text");
      expect(meta?.kind === "text" ? JSON.parse(meta.text) : null).toEqual({ title: "Nutcracker" });

      const chapterFile = await storage.readFile(`content/${MINIMAL_STORY_NODE_ID}.${DEFAULT_LANG}.txt`);
      expect(chapterFile?.kind).toBe("text");
      expect(chapterFile?.kind === "text" ? chapterFile.text : null).toBe("Nutcracker");
    });

    it("rejects creating a minimal story when the workspace is not empty, leaving it untouched", async () => {
      const storage = await openedStorage();
      const seedWrite = await storage.mutate({ expectedRevision: 0, ops: [{ op: "write", path: "meta.json", kind: "text", text: "{}" }] });
      expect(seedWrite.ok).toBe(true);
      const before = await fingerprint(storage);

      const result = await createMinimalStory(storage, { slug: "second-story", title: "Second Story" });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error : null).toEqual({ type: "workspace-not-empty", entryCount: 1 });
      expect(await fingerprint(storage)).toEqual(before);
    });

    it("rejects an invalid slug, leaving the empty workspace untouched", async () => {
      const storage = await openedStorage();
      const before = await fingerprint(storage);

      const result = await createMinimalStory(storage, { slug: "Not A Slug!", title: "Title" });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("invalid-input");
      expect(result.ok === false && result.error.type === "invalid-input" ? result.error.field : null).toBe("slug");
      expect(await fingerprint(storage)).toEqual(before);
    });

    it("rejects a blank title, leaving the empty workspace untouched", async () => {
      const storage = await openedStorage();
      const before = await fingerprint(storage);

      const result = await createMinimalStory(storage, { slug: "demo", title: "   " });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("invalid-input");
      expect(result.ok === false && result.error.type === "invalid-input" ? result.error.field : null).toBe("title");
      expect(await fingerprint(storage)).toEqual(before);
    });

    // ---- readStory ----

    it("reports story-not-found on an empty workspace instead of throwing", async () => {
      const storage = await openedStorage();

      const result = await readStory(storage);

      expect(result).toEqual({ ok: false, error: { type: "story-not-found" } });
    });

    it("reads a syntactically valid but semantically invalid story.yaml as error-level diagnostics, not a throw", async () => {
      const storage = await openedStorage();
      // Legal YAML, but kind is wrong (story-contract validate() judges it an
      // error) — proving "reading doesn't throw just because it's invalid": this
      // kind of bad data returns ok:true plus diagnostics carrying an error, not
      // ok:false.
      const badYaml = "specVersion: storymaker/v1alpha1\nkind: NotAStory\nmetadata:\n  slug: demo\nstart: p1\nnodes: {}\n";
      const seed = await storage.mutate({ expectedRevision: 0, ops: [{ op: "write", path: "story.yaml", kind: "text", text: badYaml }] });
      expect(seed.ok).toBe(true);

      const result = await readStory(storage);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.diagnostics.some((d) => d.severity === "error" && d.path === "/kind")).toBe(true);
    });

    it("reports invalid-yaml for a story.yaml that is not even legal YAML syntax", async () => {
      const storage = await openedStorage();
      const brokenYaml = "specVersion: storymaker/v1alpha1\nkind: [unterminated flow seq\n";
      const seed = await storage.mutate({ expectedRevision: 0, ops: [{ op: "write", path: "story.yaml", kind: "text", text: brokenYaml }] });
      expect(seed.ok).toBe(true);

      const result = await readStory(storage);

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("invalid-yaml");
    });

    // ---- readStory: torn reads (review fix, review P1) ----
    //
    // readStory() reading story.yaml (readFile) and its corresponding revision
    // (list()) were originally two separate storage calls, and a concurrent
    // mutate() could be inserted in between, reading a combination like "stale
    // spec + new revision" that never actually existed. The two cases below use
    // RaceInjectingStorage to issue a genuinely-landed concurrent update against
    // the underlying storage at the exact moment of the readFile() call, to prove:
    // readStory() will never return "a stale spec paired with the new revision" —
    // the result can only be "converges, after retrying, to some consistent
    // snapshot that genuinely existed" or an explicit workspace-busy.

    it("recovers from a single concurrent story.yaml update mid-read and never pairs a stale spec with the new revision", async () => {
      const inner = await openedStorage();
      const seed = await createSeedStory(inner, { slug: "race-read", title: "Torn Read" });

      async function refreshEnding(target: WorkspaceStoragePort) {
        const current = await readStory(target);
        if (!current.ok) throw new Error("test setup read failed: " + JSON.stringify(current.error));
        const written = await updateStoryStructure(target, {
          expectedRevision: current.revision,
          spec: {
            ...current.spec,
            nodes: {
              ...current.spec.nodes,
              [MINIMAL_STORY_NODE_ID]: {
                ...current.spec.nodes[MINIMAL_STORY_NODE_ID],
                ending: { endingId: `${MINIMAL_STORY_NODE_ID}-ending`, endingType: "good" },
              },
            },
          },
        });
        if (!written.ok) throw new Error("test-injected concurrent update failed: " + JSON.stringify(written.error));
      }

      // Inject only once (at the exact moment of the readFile() call, actually
      // refresh story.yaml and advance the revision) — after
      // that, subsequent retries have no more interference and should converge
      // successfully.
      const wrapper = new RaceInjectingStorage(inner, () => refreshEnding(inner), 1);

      const result = await readStory(wrapper);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The converged result must be the new spec plus the new
      // revision", a combination that genuinely existed — it must not be the
      // stale spec (endingType:"good", the value from when createSeedStory
      // created it) paired with the new revision; that's exactly the shape of the
      // original bug the review pointed out.
      expect(result.spec.nodes[MINIMAL_STORY_NODE_ID].ending?.endingType).toBe("good");
      expect(result.revision).toBe(seed.revision + 1);

      // The underlying workspace itself should also reflect this (test-injected)
      // update — read logic only reads, it never writes, so there's no reason for
      // it to have changed the workspace state back.
      const innerRead = await readStory(inner);
      expect(innerRead.ok).toBe(true);
      if (innerRead.ok) expect(innerRead.spec.nodes[MINIMAL_STORY_NODE_ID].ending?.endingType).toBe("good");
    });

    it("gives up after the retry limit and returns workspace-busy when story.yaml keeps changing during read", async () => {
      const inner = await openedStorage();
      await createSeedStory(inner, { slug: "race-read-busy", title: "Torn Read Retry Limit" });
      let counter = 0;

      async function bumpOnce() {
        counter++;
        const current = await readStory(inner);
        if (!current.ok) throw new Error("test setup read failed: " + JSON.stringify(current.error));
        const written = await updateStoryStructure(inner, {
          expectedRevision: current.revision,
          spec: {
            ...current.spec,
            nodes: {
              ...current.spec.nodes,
              [MINIMAL_STORY_NODE_ID]: {
                ...current.spec.nodes[MINIMAL_STORY_NODE_ID],
                ending: { endingId: `${MINIMAL_STORY_NODE_ID}-ending`, endingType: "good" },
              },
            },
          },
        });
        if (!written.ok) throw new Error("test-injected concurrent update failed: " + JSON.stringify(written.error));
      }

      // Every single readFile() call genuinely lands a new update — guaranteeing
      // that every round's before/after snapshots never line up, simulating a
      // situation where someone keeps changing this workspace and retries can
      // never catch up.
      const wrapper = new RaceInjectingStorage(inner, bumpOnce, Number.POSITIVE_INFINITY);

      const result = await readStory(wrapper);

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("workspace-busy");
    });

    // ---- updateStoryStructure ----

    it("replaces the whole StorySpec when the replacement validates clean", async () => {
      const storage = await openedStorage();
      const seed = await createSeedStory(storage);
      const read = await readStory(storage);
      expect(read.ok).toBe(true);
      if (!read.ok) return;

      const nextSpec: StorySpec = {
        ...read.spec,
        nodes: {
          ...read.spec.nodes,
          [MINIMAL_STORY_NODE_ID]: {
            ...read.spec.nodes[MINIMAL_STORY_NODE_ID],
            ending: { endingId: `${MINIMAL_STORY_NODE_ID}-ending`, endingType: "good" },
          },
        },
      };

      const result = await updateStoryStructure(storage, { expectedRevision: seed.revision, spec: nextSpec });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.revision).toBe(seed.revision + 1);
      const reread = await readStory(storage);
      expect(reread.ok).toBe(true);
      if (reread.ok) expect(reread.spec.nodes[MINIMAL_STORY_NODE_ID].ending?.endingType).toBe("good");
    });

    it("rejects an invalid StorySpec (error-level diagnostics) and leaves story.yaml unchanged — fail-closed #1", async () => {
      const storage = await openedStorage();
      const seed = await createSeedStory(storage);
      const currentRead = await readStory(storage);
      expect(currentRead.ok).toBe(true);
      if (!currentRead.ok) return;
      const before = await fingerprint(storage);
      // Take the currently-valid spec and just break its kind — the minimal
      // change validate() judges as "invalid", no need to also cobble together a
      // separate, shape-incomplete fake object.
      const brokenSpec: StorySpec = { ...currentRead.spec, kind: "NotAStory" as StorySpec["kind"] };

      const result = await updateStoryStructure(storage, { expectedRevision: seed.revision, spec: brokenSpec });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("invalid-story-spec");
      expect(
        result.ok === false && result.error.type === "invalid-story-spec"
          ? result.error.diagnostics.some((d) => d.path === "/kind")
          : false,
      ).toBe(true);
      expect(await fingerprint(storage)).toEqual(before);
    });

    it("rejects a stale expectedRevision on updateStoryStructure and leaves story.yaml unchanged — fail-closed #3", async () => {
      const storage = await openedStorage();
      const seed = await createSeedStory(storage);
      const currentRead = await readStory(storage);
      expect(currentRead.ok).toBe(true);
      if (!currentRead.ok) return;
      const before = await fingerprint(storage);

      const result = await updateStoryStructure(storage, { expectedRevision: seed.revision - 1, spec: currentRead.spec });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error : null).toEqual({
        type: "mutation-rejected",
        error: { type: "revision-conflict", expectedRevision: seed.revision - 1, actualRevision: seed.revision },
      });
      expect(await fingerprint(storage)).toEqual(before);
    });

    // ---- updatePageText ----

    it("writes page text for an existing chapterSlug", async () => {
      const storage = await openedStorage();
      const seed = await createSeedStory(storage);

      const result = await updatePageText(storage, {
        expectedRevision: seed.revision,
        chapterSlug: MINIMAL_STORY_NODE_ID,
        lang: DEFAULT_LANG,
        text: "Once upon a time, there was a nutcracker...",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const file = await storage.readFile(`content/${MINIMAL_STORY_NODE_ID}.${DEFAULT_LANG}.txt`);
      expect(file?.kind === "text" ? file.text : null).toBe("Once upon a time, there was a nutcracker...");
    });

    it("rejects updatePageText for a chapterSlug that is not referenced by story.yaml, leaving the workspace unchanged — fail-closed #2", async () => {
      const storage = await openedStorage();
      const seed = await createSeedStory(storage);
      const before = await fingerprint(storage);

      const result = await updatePageText(storage, {
        expectedRevision: seed.revision,
        chapterSlug: "no-such-page",
        lang: DEFAULT_LANG,
        text: "this page doesn't exist",
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error : null).toEqual({
        type: "chapter-not-found",
        chapterSlug: "no-such-page",
        knownChapterSlugs: [MINIMAL_STORY_NODE_ID],
      });
      expect(await fingerprint(storage)).toEqual(before);
    });

    it("rejects updatePageText when expectedRevision no longer matches the story.yaml revision (read/write version guard, review), leaving the workspace unchanged", async () => {
      const storage = await openedStorage();
      const seed = await createSeedStory(storage);
      // The expectedRevision the caller is holding (seed.revision) is the version
      // from "when the story was created"; before it decided to call
      // updatePageText, the workspace had already been touched by another
      // structural update (simulated here by calling updateStoryStructure
      // directly), the revision advanced, but the caller hasn't re-read to get the
      // new version yet.
      const afterSeed = await readStory(storage);
      expect(afterSeed.ok).toBe(true);
      if (!afterSeed.ok) return;
      const bump = await updateStoryStructure(storage, { expectedRevision: afterSeed.revision, spec: afterSeed.spec });
      expect(bump.ok).toBe(true);
      if (!bump.ok) return;
      const before = await fingerprint(storage);

      const result = await updatePageText(storage, {
        expectedRevision: seed.revision, // a stale version — updatePageText's internal readStory() will read the new version after the bump
        chapterSlug: MINIMAL_STORY_NODE_ID,
        lang: DEFAULT_LANG,
        text: "this write should be blocked",
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error : null).toEqual({
        type: "mutation-rejected",
        error: { type: "revision-conflict", expectedRevision: seed.revision, actualRevision: bump.revision },
      });
      expect(await fingerprint(storage)).toEqual(before);
    });

    it("rejects blank page text, leaving the workspace unchanged", async () => {
      const storage = await openedStorage();
      const seed = await createSeedStory(storage);
      const before = await fingerprint(storage);

      const result = await updatePageText(storage, {
        expectedRevision: seed.revision,
        chapterSlug: MINIMAL_STORY_NODE_ID,
        lang: DEFAULT_LANG,
        text: "   \n  ",
      });

      expect(result.ok).toBe(false);
      // NOTE: this asserts the literal error string produced by
      // ./updatePageText.ts — kept in sync
      // with its actual source string.
      expect(result.ok === false ? result.error : null).toEqual({ type: "invalid-text", reason: "text must not be blank" });
      expect(await fingerprint(storage)).toEqual(before);
    });

    it("rejects oversized page text (over the 1.1 MAX_TEXT_FILE_BYTES limit), leaving the workspace unchanged", async () => {
      const storage = await openedStorage();
      const seed = await createSeedStory(storage);
      const before = await fingerprint(storage);
      const oversized = "x".repeat(MAX_TEXT_FILE_BYTES + 1);

      const result = await updatePageText(storage, {
        expectedRevision: seed.revision,
        chapterSlug: MINIMAL_STORY_NODE_ID,
        lang: DEFAULT_LANG,
        text: oversized,
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("mutation-rejected");
      expect(
        result.ok === false && result.error.type === "mutation-rejected" ? result.error.error.type : null,
      ).toBe("size-exceeded");
      expect(await fingerprint(storage)).toEqual(before);
    });
  });
}
