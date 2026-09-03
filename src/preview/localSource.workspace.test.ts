// LocalSource (the creator's local preview) - uses
// MemoryWorkspaceStorage to walk the full I/O path (readStory -> consistent reads of
// content/media.json -> buildPreviewSnapshot()), without mocking storage itself, to prove this
// is really an implementation that can read out a correct snapshot, not just something that
// type-checks against the interface.
import { describe, expect, it } from "vitest";
import { MemoryWorkspaceStorage } from "../testing/fakes.ts";
import { ThrowingStorage } from "../testing/throwingStorage.ts";
import { createMinimalStory, readStory, updateStoryStructure } from "../story/index.ts";
import type { WorkspaceWriteOp } from "../workspace/types.ts";
import { LocalSource } from "./localSource.ts";

async function makeStorage(): Promise<MemoryWorkspaceStorage> {
  const storage = new MemoryWorkspaceStorage();
  await storage.open();
  return storage;
}

describe("LocalSource.load()", () => {
  it("returns no-story when the workspace is completely empty", async () => {
    const storage = await makeStorage();
    const source = new LocalSource(storage);

    const result = await source.load();

    expect(result).toEqual({ ok: false, error: { type: "no-story" } });
  });

  it("returns invalid-story when story.yaml is corrupted (not valid YAML)", async () => {
    const storage = await makeStorage();
    const snapshot = await storage.list();
    const ops: WorkspaceWriteOp[] = [{ op: "write", path: "story.yaml", kind: "text", text: "{ this is not valid YAML :::" }];
    const mutation = await storage.mutate({ expectedRevision: snapshot.revision, ops });
    expect(mutation.ok).toBe(true);

    const source = new LocalSource(storage);
    const result = await source.load();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("invalid-story");
  });

  it("a valid story: reads out the correct title (meta.json), content (content fragment), start/pages fixed up", async () => {
    const storage = await makeStorage();
    const created = await createMinimalStory(storage, { slug: "demo", title: "Sample Story" });
    expect(created.ok).toBe(true);

    const source = new LocalSource(storage);
    const result = await source.load();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.story.title).toBe("Sample Story");
    // createMinimalStory() uses the title itself as the first page fragment's initial content
    // (see the header notes in ../story/createMinimalStory.ts).
    expect(result.snapshot.story.pages).toHaveLength(1);
    expect(result.snapshot.story.pages[0]!.text).toBe("Sample Story");
    expect(result.snapshot.story.pages[0]!.choices).toEqual([]);
    expect(result.snapshot.story.pages[0]!.next).toBeUndefined();
    expect(result.snapshot.images).toEqual([]);
  });

  it("falls back to storySlug for the title when meta.json doesn't exist / has no valid title", async () => {
    const storage = await makeStorage();
    const created = await createMinimalStory(storage, { slug: "demo", title: "Sample Story" });
    expect(created.ok).toBe(true);

    // Directly wipe meta.json (simulating "meta.json exists but has no valid title"), without
    // going through any public API - this only exists to construct this edge case; it isn't
    // meant to represent a normal operation path.
    const snapshot = await storage.list();
    const mutation = await storage.mutate({
      expectedRevision: snapshot.revision,
      ops: [{ op: "write", path: "meta.json", kind: "text", text: "{}" }],
    });
    expect(mutation.ok).toBe(true);

    const source = new LocalSource(storage);
    const result = await source.load();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.story.title).toBe("demo");
  });

  it("an approved illustration (the media/<chapterSlug>.<ext> file exists) shows up in the snapshot", async () => {
    const storage = await makeStorage();
    const created = await createMinimalStory(storage, { slug: "demo", title: "Sample Story" });
    expect(created.ok).toBe(true);

    const imageBytes = new Uint8Array([1, 2, 3, 4]);
    const snapshot = await storage.list();
    const mutation = await storage.mutate({
      expectedRevision: snapshot.revision,
      ops: [{ op: "write", path: "media/page-01.png", kind: "blob", bytes: imageBytes }],
    });
    expect(mutation.ok).toBe(true);

    const source = new LocalSource(storage);
    const result = await source.load();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.story.pages[0]!.imageId).toBe("page-01");
    expect(result.snapshot.images).toEqual([{ id: "page-01", mime: "image/png", byteLength: imageBytes.length }]);
  });

  it("a branching story: choices are assembled correctly", async () => {
    const storage = await makeStorage();
    const created = await createMinimalStory(storage, { slug: "demo", title: "Sample Story" });
    expect(created.ok).toBe(true);

    const current = await readStory(storage);
    expect(current.ok).toBe(true);
    if (!current.ok) return;

    const updated = await updateStoryStructure(storage, {
      expectedRevision: current.revision,
      spec: {
        ...current.spec,
        start: "start",
        nodes: {
          start: {
            content: { $ref: "content://demo/chapters/start#fragments/text" },
            choices: {
              "go-left": { target: "left-ending" },
              "go-right": { target: "right-ending" },
            },
          },
          "left-ending": {
            type: "ending",
            content: { $ref: "content://demo/chapters/left-ending#fragments/text" },
            ending: { endingId: "left-ending-id", endingType: "good" },
          },
          "right-ending": {
            type: "ending",
            content: { $ref: "content://demo/chapters/right-ending#fragments/text" },
            ending: { endingId: "right-ending-id", endingType: "good" },
          },
        },
      },
    });
    expect(updated.ok).toBe(true);

    const source = new LocalSource(storage);
    const result = await source.load();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.story.startPageId).toBe("start");
    const startPage = result.snapshot.story.pages.find((p) => p.id === "start")!;
    expect(startPage.choices).toHaveLength(2);
    expect(new Set(startPage.choices.map((c) => c.target))).toEqual(new Set(["left-ending", "right-ending"]));
  });
});

describe("LocalSource.image()", () => {
  it("reads out an approved illustration's full bytes", async () => {
    const storage = await makeStorage();
    const created = await createMinimalStory(storage, { slug: "demo", title: "Sample Story" });
    expect(created.ok).toBe(true);

    const imageBytes = new Uint8Array([9, 8, 7, 6, 5]);
    const snapshot = await storage.list();
    const mutation = await storage.mutate({
      expectedRevision: snapshot.revision,
      ops: [{ op: "write", path: "media/page-01.webp", kind: "blob", bytes: imageBytes }],
    });
    expect(mutation.ok).toBe(true);

    const source = new LocalSource(storage);
    const bytes = await source.image("page-01");

    expect(bytes).toEqual(imageBytes);
  });

  it("returns undefined when the matching file isn't found, never fabricating an image", async () => {
    const storage = await makeStorage();
    const source = new LocalSource(storage);

    const bytes = await source.image("does-not-exist");

    expect(bytes).toBeUndefined();
  });
});

describe("LocalSource - collapsing storage exceptions", () => {
  it("returns unavailable instead of letting the exception escape when load()'s underlying storage.list() throws", async () => {
    const inner = await makeStorage();
    const created = await createMinimalStory(inner, { slug: "demo", title: "Sample Story" });
    expect(created.ok).toBe(true);

    const throwing = new ThrowingStorage(inner);
    throwing.throwOnNextCall("list");
    const source = new LocalSource(throwing);

    const result = await source.load();

    expect(result).toEqual({ ok: false, error: { type: "unavailable" } });
  });

  it("returns undefined instead of letting the exception escape when image()'s underlying storage.list() throws", async () => {
    const inner = await makeStorage();
    const created = await createMinimalStory(inner, { slug: "demo", title: "Sample Story" });
    expect(created.ok).toBe(true);
    const snapshot = await inner.list();
    const mutation = await inner.mutate({
      expectedRevision: snapshot.revision,
      ops: [{ op: "write", path: "media/page-01.png", kind: "blob", bytes: new Uint8Array([1, 2, 3]) }],
    });
    expect(mutation.ok).toBe(true);

    const throwing = new ThrowingStorage(inner);
    throwing.throwOnNextCall("list");
    const source = new LocalSource(throwing);

    const bytes = await source.image("page-01");

    expect(bytes).toBeUndefined();
  });
});

describe("LocalSource.dispose()", () => {
  it("is a safe no-op (holds no resources)", async () => {
    const storage = await makeStorage();
    const source = new LocalSource(storage);
    expect(() => source.dispose()).not.toThrow();
    expect(() => source.dispose()).not.toThrow(); // safe to call more than once
  });
});
