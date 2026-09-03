// Reusable contract tests for WorkspaceStoragePort -- the same behavioral
// assertions applied against any port implementation. Both
// MemoryWorkspaceStorage and the IndexedDB adapter run this suite; adding
// another backend only needs a new caller test file that imports this
// describeWorkspaceStorageContract() with a new factory, without rewriting the contract
// itself -- this same
// contract test suite is the direct means of acceptance.
//
// Each case verifies observable results (the content read back, revision, file list,
// rejection reason), not "was the function called" (a hard requirement for shared
// acceptance protocol).
//
// This file itself is not a vitest test entry point (its file name has no .test suffix, so
// vitest's file glob never loads it directly) -- it's only imported by real
// *.workspace.test.ts files, which call describeWorkspaceStorageContract() in their own
// module scope to register describe/it; the timing still falls within vitest's collection
// phase, behaving the same as if the whole test suite were written directly in that file.
import { describe, expect, it } from "vitest";
import type { WorkspaceStoragePort } from "../ports.ts";

export function describeWorkspaceStorageContract(name: string, makeStorage: () => WorkspaceStoragePort): void {
  describe(`WorkspaceStoragePort contract — ${name}`, () => {
    async function openedStorage(): Promise<WorkspaceStoragePort> {
      const storage = makeStorage();
      await storage.open();
      return storage;
    }

    it("round-trips a legal text file (story.yaml)", async () => {
      const storage = await openedStorage();
      const yaml = "specVersion: storymaker/v1alpha1\nkind: Story\nstart: page-01\n";

      const result = await storage.mutate({
        expectedRevision: 0,
        ops: [{ op: "write", path: "story.yaml", kind: "text", text: yaml }],
      });

      expect(result).toEqual({ ok: true, revision: 1 });
      expect(await storage.readFile("story.yaml")).toEqual({ kind: "text", path: "story.yaml", text: yaml });
    });

    it("round-trips a legal English fragment file", async () => {
      const storage = await openedStorage();
      const text = "Once upon a time...";

      const result = await storage.mutate({
        expectedRevision: 0,
        ops: [{ op: "write", path: "content/page-01-body.en.txt", kind: "text", text }],
      });

      expect(result.ok).toBe(true);
      expect(await storage.readFile("content/page-01-body.en.txt")).toEqual({
        kind: "text",
        path: "content/page-01-body.en.txt",
        text,
      });
    });

    it("round-trips a legal media blob and verifies the actual bytes, not just presence", async () => {
      const storage = await openedStorage();
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5]); // PNG magic + payload

      const result = await storage.mutate({
        expectedRevision: 0,
        ops: [{ op: "write", path: "media/cover.png", kind: "blob", bytes }],
      });

      expect(result.ok).toBe(true);
      const file = await storage.readFile("media/cover.png");
      expect(file?.kind).toBe("blob");
      expect(file?.kind === "blob" ? Array.from(file.bytes) : null).toEqual(Array.from(bytes));
    });

    it("lists written files with correct kind and byteLength", async () => {
      const storage = await openedStorage();
      await storage.mutate({
        expectedRevision: 0,
        ops: [
          { op: "write", path: "story.yaml", kind: "text", text: "abc" },
          { op: "write", path: "media/cover.png", kind: "blob", bytes: new Uint8Array([1, 2, 3, 4]) },
        ],
      });

      const snapshot = await storage.list();
      expect(snapshot.revision).toBe(1);
      expect([...snapshot.entries].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: "media/cover.png", kind: "blob", byteLength: 4 },
        { path: "story.yaml", kind: "text", byteLength: 3 },
      ]);
    });

    it("rejects path traversal and leaves revision/file list unchanged", async () => {
      const storage = await openedStorage();

      const result = await storage.mutate({
        expectedRevision: 0,
        ops: [{ op: "write", path: "../story.yaml", kind: "text", text: "x" }],
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("invalid-path");
      const snapshot = await storage.list();
      expect(snapshot.revision).toBe(0);
      expect(snapshot.entries).toEqual([]);
    });

    it("rejects an absolute path", async () => {
      const storage = await openedStorage();

      const result = await storage.mutate({
        expectedRevision: 0,
        ops: [{ op: "write", path: "/story.yaml", kind: "text", text: "x" }],
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("invalid-path");
      expect((await storage.list()).entries).toEqual([]);
    });

    it("rejects a reserved/hidden path", async () => {
      const storage = await openedStorage();

      const result = await storage.mutate({
        expectedRevision: 0,
        ops: [{ op: "write", path: ".env", kind: "text", text: "SECRET=1" }],
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("invalid-path");
      expect((await storage.list()).entries).toEqual([]);
    });

    it("rejects an unknown extension under media/", async () => {
      const storage = await openedStorage();

      const result = await storage.mutate({
        expectedRevision: 0,
        ops: [{ op: "write", path: "media/cover.gif", kind: "blob", bytes: new Uint8Array([1]) }],
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("invalid-path");
      expect((await storage.list()).entries).toEqual([]);
    });

    it("rejects an unlisted root file name", async () => {
      const storage = await openedStorage();

      const result = await storage.mutate({
        expectedRevision: 0,
        ops: [{ op: "write", path: "arbitrary.json", kind: "text", text: "{}" }],
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("invalid-path");
      expect((await storage.list()).entries).toEqual([]);
    });

    it("rejects a stale expectedRevision as a distinguishable conflict, leaving data unchanged", async () => {
      const storage = await openedStorage();
      await storage.mutate({
        expectedRevision: 0,
        ops: [{ op: "write", path: "story.yaml", kind: "text", text: "v1" }],
      });

      const stale = await storage.mutate({
        expectedRevision: 0, // it's already 1 now, this write is carrying the stale 0
        ops: [{ op: "write", path: "story.yaml", kind: "text", text: "v2" }],
      });

      expect(stale.ok).toBe(false);
      expect(stale.ok === false ? stale.error : null).toEqual({
        type: "revision-conflict",
        expectedRevision: 0,
        actualRevision: 1,
      });
      expect(await storage.readFile("story.yaml")).toEqual({ kind: "text", path: "story.yaml", text: "v1" });
      expect((await storage.list()).revision).toBe(1);
    });

    it("zero partial writes: an illegal Nth op aborts the whole batch, including the legal ops before it", async () => {
      const storage = await openedStorage();

      const result = await storage.mutate({
        expectedRevision: 0,
        ops: [
          { op: "write", path: "story.yaml", kind: "text", text: "legal-1" },
          { op: "write", path: "meta.json", kind: "text", text: "legal-2" },
          { op: "write", path: "../escape.yaml", kind: "text", text: "illegal-3rd" },
        ],
      });

      expect(result.ok).toBe(false);
      const snapshot = await storage.list();
      expect(snapshot.revision).toBe(0);
      expect(snapshot.entries).toEqual([]); // neither of the two legal writes (story.yaml/meta.json) landed either
      expect(await storage.readFile("story.yaml")).toBeUndefined();
      expect(await storage.readFile("meta.json")).toBeUndefined();
    });

    it("rejects a write whose declared kind doesn't match the path's classification", async () => {
      const storage = await openedStorage();

      const result = await storage.mutate({
        expectedRevision: 0,
        ops: [{ op: "write", path: "story.yaml", kind: "blob", bytes: new Uint8Array([1, 2, 3]) }],
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("type-mismatch");
      expect((await storage.list()).entries).toEqual([]);
    });

    it("rejects a single text file exceeding the per-file size limit", async () => {
      const storage = await openedStorage();
      const oversized = "x".repeat(3 * 1024 * 1024); // > MAX_TEXT_FILE_BYTES (2 MiB)

      const result = await storage.mutate({
        expectedRevision: 0,
        ops: [{ op: "write", path: "story.yaml", kind: "text", text: oversized }],
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("size-exceeded");
      expect((await storage.list()).entries).toEqual([]);
    });

    it("delete removes a file and bumps revision; a subsequent read returns undefined", async () => {
      const storage = await openedStorage();
      await storage.mutate({
        expectedRevision: 0,
        ops: [{ op: "write", path: "story.yaml", kind: "text", text: "v1" }],
      });

      const result = await storage.mutate({ expectedRevision: 1, ops: [{ op: "delete", path: "story.yaml" }] });

      expect(result).toEqual({ ok: true, revision: 2 });
      expect(await storage.readFile("story.yaml")).toBeUndefined();
      expect((await storage.list()).entries).toEqual([]);
    });

    it("rejects deleting a path that does not exist, leaving revision unchanged", async () => {
      const storage = await openedStorage();

      const result = await storage.mutate({ expectedRevision: 0, ops: [{ op: "delete", path: "story.yaml" }] });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("invalid-path");
      expect((await storage.list()).revision).toBe(0);
    });

    it("rejects an empty mutation batch", async () => {
      const storage = await openedStorage();

      const result = await storage.mutate({ expectedRevision: 0, ops: [] });

      expect(result.ok).toBe(false);
      expect(result.ok === false ? result.error.type : null).toBe("empty-batch");
    });
  });
}
