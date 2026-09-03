// Transaction failure injection -- deliberately makes an
// IndexedDB write fail partway through mutate()'s persistence, asserting
// that after the failure, revision/file list/blob bytes exactly match their
// state before the failure (zero half-written data).
//
// This test checks "the atomicity of the IndexedDB transaction itself",
// which is a different thing from the "zero partial writes" case in
// ../workspace/contract.ts (which checks that the planMutation pure
// function rejects an illegal op early, never reaching persistence at all)
// -- here the mutation itself is entirely legal and passes planMutation's
// planning; the failure happens "after" planning, at the actual persistence
// stage (simulating a hardware/browser-level storage fault, e.g. quota
// exceeded or the tab getting killed), checking whether the adapter, faced
// with this kind of failure, really does abort the transaction and leave no
// partial writes behind.
//
// Injection technique: monkeypatch fake-indexeddb's
// IDBObjectStore.prototype.put so that the second put() call within one
// mutate() throws synchronously -- the first, legal put() has already been
// queued in the same transaction. The point being verified is precisely
// that "even though the first one is legal and already queued, once the
// whole transaction aborts, it too must be rolled back".
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbWorkspaceStorage } from "./indexeddbWorkspaceStorage.ts";

describe("IndexedDbWorkspaceStorage transaction failure injection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("when the persistence transaction fails partway through, revision/file list/blob bytes exactly match their pre-failure state", async () => {
    const idb = new IDBFactory();
    const storage = new IndexedDbWorkspaceStorage({ indexedDB: idb, dbName: "transaction-failure-test" });
    await storage.open();

    const originalYaml = "specVersion: storymaker/v1alpha1\nkind: Story\nstart: page-01\n";
    const coverBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6, 5]);

    const baseline = await storage.mutate({
      expectedRevision: 0,
      ops: [
        { op: "write", path: "story.yaml", kind: "text", text: originalYaml },
        { op: "write", path: "media/cover.png", kind: "blob", bytes: coverBytes },
      ],
    });
    expect(baseline).toEqual({ ok: true, revision: 1 });

    const snapshotBefore = await storage.list();
    const storyBefore = await storage.readFile("story.yaml");
    const coverBefore = await storage.readFile("media/cover.png");
    expect(snapshotBefore.revision).toBe(1);

    // Injection: this mutation is entirely legal as far as planMutation is
    // concerned (two legal writes); the second put() call throws a
    // simulated persistence error synchronously -- the first has already
    // been queued in the transaction.
    const originalPut = IDBObjectStore.prototype.put;
    let putCallCount = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      putCallCount += 1;
      if (putCallCount === 2) {
        throw new Error("injected persistence failure (simulating quota exceeded / storage fault)");
      }
      return originalPut.apply(this, args);
    });

    await expect(
      storage.mutate({
        expectedRevision: 1,
        ops: [
          { op: "write", path: "meta.json", kind: "text", text: '{"title":"New Title"}' }, // first put -- already queued
          { op: "write", path: "content/page-01-body.en.txt", kind: "text", text: "half-written content" }, // second put -- injected failure
        ],
      }),
    ).rejects.toThrow("injected persistence failure");

    vi.restoreAllMocks();

    // Zero half-written data: revision, file list, and existing file content
    // (including blob bytes) must each match their pre-failure state exactly.
    const snapshotAfter = await storage.list();
    expect(snapshotAfter).toEqual(snapshotBefore);
    expect(snapshotAfter.revision).toBe(1);

    expect(await storage.readFile("story.yaml")).toEqual(storyBefore);
    const coverAfter = await storage.readFile("media/cover.png");
    expect(coverAfter?.kind).toBe("blob");
    expect(coverAfter?.kind === "blob" ? Array.from(coverAfter.bytes) : null).toEqual(
      coverBefore?.kind === "blob" ? Array.from(coverBefore.bytes) : null,
    );

    // The first, legal put (meta.json) was already queued, but because the
    // same transaction aborts, it too must be rolled back -- it's not just
    // the second, failed file that goes unwritten, the whole batch does.
    expect(await storage.readFile("meta.json")).toBeUndefined();
    expect(await storage.readFile("content/page-01-body.en.txt")).toBeUndefined();

    // The adapter isn't corrupted by one failed transaction -- a subsequent
    // legal mutate() still works normally, and the revision the OCC picks
    // up from is exactly the pre-failure 1 (the failed attempt never
    // advanced the revision).
    const after = await storage.mutate({
      expectedRevision: 1,
      ops: [{ op: "write", path: "meta.json", kind: "text", text: '{"title":"Normal Write"}' }],
    });
    expect(after).toEqual({ ok: true, revision: 2 });
  });
});
