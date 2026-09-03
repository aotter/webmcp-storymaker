// Reload/hydrate acceptance -- against the same fake IndexedDB
// backend (the same IDBFactory instance + the same dbName), one adapter
// instance writes data and then close()s, then a "brand new" adapter
// instance open()s the same database, asserting that list()/readFile() read
// back exactly the same content (including a byte-for-byte comparison of
// blob bytes, not just "does it exist"). This simulates a browser tab
// reload -- after a tab refresh all JS memory resets to zero, only the data
// in IndexedDB survives, and the new adapter instance must be able to fully
// hydrate back the same workspace.
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IndexedDbWorkspaceStorage } from "./indexeddbWorkspaceStorage.ts";

describe("IndexedDbWorkspaceStorage reload/hydrate", () => {
  it("after reload (closing the old adapter and opening a brand new one), list/readFile/revision exactly match before reload", async () => {
    const idb = new IDBFactory();
    const dbName = "reload-hydrate-test";
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42, 7, 255, 0, 128]);

    const before = new IndexedDbWorkspaceStorage({ indexedDB: idb, dbName });
    await before.open();
    const yaml = "specVersion: storymaker/v1alpha1\nkind: Story\nstart: page-01\n";
    const mutation1 = await before.mutate({
      expectedRevision: 0,
      ops: [
        { op: "write", path: "story.yaml", kind: "text", text: yaml },
        { op: "write", path: "media/cover.png", kind: "blob", bytes: pngBytes },
      ],
    });
    expect(mutation1).toEqual({ ok: true, revision: 1 });

    const mutation2 = await before.mutate({
      expectedRevision: 1,
      ops: [{ op: "write", path: "content/page-01-body.en.txt", kind: "text", text: "Once upon a time..." }],
    });
    expect(mutation2).toEqual({ ok: true, revision: 2 });

    const snapshotBefore = await before.list();
    await before.close(); // simulates a tab reload: the old adapter instance's connection closes

    // A brand new adapter instance -- shares no JS memory state, only the
    // underlying idb + dbName.
    const after = new IndexedDbWorkspaceStorage({ indexedDB: idb, dbName });
    await after.open();

    const snapshotAfter = await after.list();
    expect(snapshotAfter.revision).toBe(2);
    expect(snapshotAfter).toEqual(snapshotBefore);

    const storyFile = await after.readFile("story.yaml");
    expect(storyFile).toEqual({ kind: "text", path: "story.yaml", text: yaml });

    const fragmentFile = await after.readFile("content/page-01-body.en.txt");
    expect(fragmentFile).toEqual({ kind: "text", path: "content/page-01-body.en.txt", text: "Once upon a time..." });

    const coverFile = await after.readFile("media/cover.png");
    expect(coverFile?.kind).toBe("blob");
    // Byte-for-byte comparison, not just "it returned some blob".
    expect(coverFile?.kind === "blob" ? Array.from(coverFile.bytes) : null).toEqual(Array.from(pngBytes));

    // Continuing to mutate on the new adapter after reload must also
    // correctly pick up the revision where it left off (the OCC read comes
    // from the real revision in IndexedDB, not any leftover in-memory cache
    // -- this adapter never had a cache to begin with; this is an extra
    // check that the continuation behavior itself is correct).
    const mutation3 = await after.mutate({
      expectedRevision: 2,
      ops: [{ op: "delete", path: "media/cover.png" }],
    });
    expect(mutation3).toEqual({ ok: true, revision: 3 });
    expect(await after.readFile("media/cover.png")).toBeUndefined();
  });
});
