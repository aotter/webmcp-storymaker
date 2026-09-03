// Whole-StorySpec replacement — story.yaml is the source of truth, so
// updating the structure just means re-stringifying the whole thing.
// story-contract validate() must fully pass before writing
// (error-level diagnostics = reject); OCC follows the workspace revision (the
// existing expectedRevision mechanism in ../workspace/mutate.ts), no second
// version-number scheme is invented.
//
// Unlike ./readStory.ts's torn-read fix, this function is
// not affected by the same class of problem — it only reads "the input.spec the
// caller passed in directly" (it never internally calls storage.readFile() to
// interpret the current state, nor does it need the current state to validate
// anything); the only preparation before writing is validate(input.spec) (a pure
// function that touches no storage). The only thing that actually touches storage
// is this final mutate() call, and mutate() itself is already a single atomic
// operation of "apply a batch of ops against one expectedRevision via OCC, commit
// only if everything is legal" (../workspace/mutate.ts) — there's no "reading spans
// multiple storage calls" here, so there's naturally no opening for a torn read,
// and no need to add an optimistic retry to match readStory().
import { stringify as stringifyYaml } from "yaml";
import { validate } from "../contract/validate.ts";
import type { StorySpec } from "../contract/types.ts";
import type { WorkspaceStoragePort } from "../ports.ts";
import type { UpdateStoryStructureResult } from "./types.ts";

export interface UpdateStoryStructureInput {
  readonly expectedRevision: number;
  readonly spec: StorySpec;
}

export async function updateStoryStructure(
  storage: WorkspaceStoragePort,
  input: UpdateStoryStructureInput,
): Promise<UpdateStoryStructureResult> {
  const errors = validate(input.spec).filter((d) => d.severity === "error");
  if (errors.length > 0) {
    return { ok: false, error: { type: "invalid-story-spec", diagnostics: errors } };
  }

  const storyYamlText = stringifyYaml(input.spec);
  const result = await storage.mutate({
    expectedRevision: input.expectedRevision,
    ops: [{ op: "write", path: "story.yaml", kind: "text", text: storyYamlText }],
  });
  if (!result.ok) {
    // mutate()'s own WorkspaceMutationError passes through as-is
    // (revision-conflict/size-exceeded/batch-too-large/...) — OCC following the
    // workspace revision means this error is not re-wrapped; the
    // revision-conflict message the caller sees carries the same semantics as
    // every other write operation at the workspace layer.
    return { ok: false, error: { type: "mutation-rejected", error: result.error } };
  }
  return { ok: true, revision: result.revision };
}
