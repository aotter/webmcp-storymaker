// Direct unit tests for planMutation -- covering batch-level edge cases that
// contract.ts (which tests indirectly through the port) doesn't reach: the op-count limit,
// the batch total byte limit, and within-a-single-batch scenarios like "write then delete
// the same path," which are only convenient to construct by calling the pure function
// directly.
import { describe, expect, it } from "vitest";
import { MAX_MUTATION_OPS, MAX_MUTATION_TOTAL_BYTES } from "./limits.ts";
import { planMutation } from "./mutate.ts";
import type { WorkspaceState, WorkspaceWriteOp } from "./types.ts";

const emptyState: WorkspaceState = { revision: 0, files: new Map() };

describe("planMutation", () => {
  it("rejects a batch with more ops than MAX_MUTATION_OPS, without touching state", () => {
    const ops: WorkspaceWriteOp[] = Array.from({ length: MAX_MUTATION_OPS + 1 }, (_, i) => ({
      op: "write",
      path: `content/frag-${i}.en.txt`,
      kind: "text",
      text: "x",
    }));

    const result = planMutation(emptyState, { expectedRevision: 0, ops });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error.type : null).toBe("batch-too-large");
  });

  it("accepts a batch right at MAX_MUTATION_OPS", () => {
    const ops: WorkspaceWriteOp[] = Array.from({ length: MAX_MUTATION_OPS }, (_, i) => ({
      op: "write",
      path: `content/frag-${i}.en.txt`,
      kind: "text",
      text: "x",
    }));

    const result = planMutation(emptyState, { expectedRevision: 0, ops });

    expect(result.ok).toBe(true);
  });

  it("rejects a batch whose cumulative byte total exceeds MAX_MUTATION_TOTAL_BYTES even though each file is individually within the per-file limit", () => {
    // Two blobs of ~45MiB each (within the 50MiB per-file limit), totaling ~90MiB > the 80MiB batch limit.
    const chunk = new Uint8Array(45 * 1024 * 1024);
    const result = planMutation(emptyState, {
      expectedRevision: 0,
      ops: [
        { op: "write", path: "media/a.png", kind: "blob", bytes: chunk },
        { op: "write", path: "media/b.png", kind: "blob", bytes: chunk },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error.type : null).toBe("batch-too-large");
    expect(result.ok === false && result.error.type === "batch-too-large" ? result.error.reason : "").toContain(
      String(MAX_MUTATION_TOTAL_BYTES)
    );
  });

  it("within one batch, a write followed by a delete of the same path resolves to deleted", () => {
    const result = planMutation(emptyState, {
      expectedRevision: 0,
      ops: [
        { op: "write", path: "story.yaml", kind: "text", text: "v1" },
        { op: "delete", path: "story.yaml" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.plan.nextFiles.has("story.yaml") : true).toBe(false);
  });

  it("within one batch, a delete followed by a re-write of the same path resolves to the new content", () => {
    const seeded: WorkspaceState = {
      revision: 3,
      files: new Map([["story.yaml", { kind: "text", path: "story.yaml", text: "old" }]]),
    };

    const result = planMutation(seeded, {
      expectedRevision: 3,
      ops: [
        { op: "delete", path: "story.yaml" },
        { op: "write", path: "story.yaml", kind: "text", text: "new" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.plan.nextFiles.get("story.yaml") : null).toEqual({
      kind: "text",
      path: "story.yaml",
      text: "new",
    });
    expect(result.ok ? result.plan.nextRevision : null).toBe(4);
  });

  it("never mutates the input state object on failure (purity)", () => {
    const seeded: WorkspaceState = {
      revision: 0,
      files: new Map([["story.yaml", { kind: "text", path: "story.yaml", text: "keep-me" }]]),
    };
    const snapshotBefore = new Map(seeded.files);

    const result = planMutation(seeded, {
      expectedRevision: 0,
      ops: [{ op: "write", path: "../escape.yaml", kind: "text", text: "x" }],
    });

    expect(result.ok).toBe(false);
    expect(seeded.files).toEqual(snapshotBefore);
    expect(seeded.revision).toBe(0);
  });
});
