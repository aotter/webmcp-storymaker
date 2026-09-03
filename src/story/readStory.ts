// Read story.yaml -> yaml parse -> return the parsed StorySpec + validate
// diagnostics. Reading itself doesn't blow up on "invalid content" — a story being
// edited can legitimately be temporarily invalid.
//
// The read-side sibling of a wider export-consistency issue: story.yaml's
// content (readFile) and its corresponding workspace revision (list()) used to be
// two separate storage calls fired concurrently via `Promise.all` — nothing
// guaranteed the two calls saw the same workspace version. Real scenario: R1 reads
// old spec A, and meanwhile a concurrent mutate() commits the workspace to R2 (new
// spec B); the list() call gets R2 -> readStory() returns "spec A + revision 2," a
// combination that never actually existed. If the caller takes that revision into
// updateStoryStructure(), it can legally overwrite B (using an edit based on A —
// the OCC check sees expectedRevision matching actualRevision; the culprit is that
// the revision matches but the spec is no longer that revision's content).
// updatePageText() is worse: it validates chapterSlug against A but writes onto R2,
// potentially producing an orphan fragment that B never referenced at all.
//
// Fix: optimistic retry — list() for a "before" snapshot -> readFile("story.yaml")
// -> list() again for an "after" snapshot. Only when the two snapshots (revision +
// entries) are identical does this readFile() call's content actually correspond to
// that revision; otherwise the whole round is discarded and retried (shared
// comparison logic in ../workspace/snapshot.ts's
// snapshotsMatch/CONSISTENT_READ_MAX_ATTEMPTS — not reimplemented here;
// ../story/readiness.ts and ../media/setPageImage.ts are callers of the same
// skeleton). Once retries are exhausted without a consistent snapshot, this returns
// an explicit workspace-busy instead of pretending a clean version was read.
//
// Only three situations count as the read itself failing (ok: false), not "return a
// pile of error diagnostics":
//   - story-not-found: there's no story.yaml in the workspace at all — the normal
//     state of a single-story workspace before createMinimalStory() has ever run,
//     not data corruption; the caller should guide the user to create a story
//     first.
//   - invalid-yaml: story.yaml's content isn't even valid YAML syntax, or it
//     parses to something that isn't an object shape — this is genuine data
//     corruption (e.g. the file was hand-edited into a broken state), a completely
//     different tier of problem from "some semantic error diagnostics" (the spec's
//     shape is correct, some fields just aren't filled in), and the two must not
//     be conflated.
//   - workspace-busy: the torn-read retries above were exhausted.
import { parse as parseYaml } from "yaml";
import { validate } from "../contract/validate.ts";
import type { Diagnostic, StorySpec } from "../contract/types.ts";
import type { WorkspaceStoragePort } from "../ports.ts";
import { CONSISTENT_READ_MAX_ATTEMPTS, snapshotsMatch } from "../workspace/snapshot.ts";
import type { ReadStoryResult } from "./types.ts";

function looksLikeStorySpecShape(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readStory(storage: WorkspaceStoragePort): Promise<ReadStoryResult> {
  for (let attempt = 1; attempt <= CONSISTENT_READ_MAX_ATTEMPTS; attempt++) {
    const before = await storage.list();
    const file = await storage.readFile("story.yaml");
    const after = await storage.list();
    if (!snapshotsMatch(before, after)) continue; // torn read, discard this whole round and retry

    // From here on, the before/after snapshots match, so what `file` read this
    // time really does correspond to the after.revision version (regardless of
    // whether `file` is undefined — "this consistent version genuinely has no
    // story.yaml" and "it was deleted mid-read" are two different things; the
    // former should not trigger a retry, and it's already ruled out by
    // snapshotsMatch above).
    if (!file) {
      return { ok: false, error: { type: "story-not-found" } };
    }
    if (file.kind !== "text") {
      // ../workspace/paths.ts's allowlist guarantees story.yaml is always
      // classified as text — this is a defensive fail-closed, not an assumption
      // that the underlying storage (especially any future other
      // WorkspaceStoragePort implementation) is always honest.
      return { ok: false, error: { type: "invalid-yaml", reason: "story.yaml is not text content" } };
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(file.text);
    } catch (error) {
      return { ok: false, error: { type: "invalid-yaml", reason: `YAML syntax error: ${(error as Error).message}` } };
    }
    if (!looksLikeStorySpecShape(parsed)) {
      return { ok: false, error: { type: "invalid-yaml", reason: "story.yaml content is not an object shape, cannot be read as a StorySpec" } };
    }

    const spec = parsed as unknown as StorySpec;
    let diagnostics: Diagnostic[];
    try {
      diagnostics = validate(spec);
    } catch (error) {
      // validate() (packages/story-contract/src/validate.ts) assumes fields are
      // roughly the right shape; a hand-broken story.yaml can feed it a shape that
      // makes it throw (e.g. a value under nodes that isn't an object). Reading's
      // stance is "don't blow up on invalid" — here the exception is caught and
      // turned into a single error diagnostic instead of letting it propagate up
      // through the caller.
      diagnostics = [
        {
          severity: "error",
          path: "",
          message: `validate() failed (story.yaml shape is severely malformed): ${(error as Error).message}`,
        },
      ];
    }

    return { ok: true, revision: after.revision, spec, diagnostics };
  }

  return {
    ok: false,
    error: {
      type: "workspace-busy",
      reason: `the workspace kept changing while reading story.yaml; still couldn't get a consistent snapshot after ${CONSISTENT_READ_MAX_ATTEMPTS} retries, please try again later`,
    },
  };
}
