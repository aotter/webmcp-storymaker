// The pure planning function for workspace mutation. Given the current state plus
// a batch of ops, it outputs either "the next state, if everything is legal" or "the error at
// the first illegal point" -- it never applies partially: draft is just a local
// copy-on-write Map, and any single op failing makes the whole function return an error; as
// long as callers (the memory implementation, the future IndexedDB adapter) only swap draft
// in as the new state when planning succeeds, atomicity (zero partial writes) falls out
// naturally, with no need to wrap their own rollback logic around it.
import { classifyWorkspacePath } from "./paths.ts";
import { MAX_BLOB_FILE_BYTES, MAX_MUTATION_OPS, MAX_MUTATION_TOTAL_BYTES, MAX_TEXT_FILE_BYTES } from "./limits.ts";
import type {
  WorkspaceFile,
  WorkspaceMutation,
  WorkspaceMutationError,
  WorkspaceState,
} from "./types.ts";

const textEncoder = new TextEncoder();

function byteLengthOf(file: WorkspaceFile): number {
  return file.kind === "text" ? textEncoder.encode(file.text).length : file.bytes.length;
}

export interface MutationPlan {
  readonly nextFiles: ReadonlyMap<string, WorkspaceFile>;
  readonly nextRevision: number;
}

export type MutationPlanResult =
  | { readonly ok: true; readonly plan: MutationPlan }
  | { readonly ok: false; readonly error: WorkspaceMutationError };

/** Pure function: does not mutate state, does no I/O. The same state fed the same mutation
 * always produces the same result. */
export function planMutation(state: WorkspaceState, mutation: WorkspaceMutation): MutationPlanResult {
  if (mutation.expectedRevision !== state.revision) {
    return {
      ok: false,
      error: {
        type: "revision-conflict",
        expectedRevision: mutation.expectedRevision,
        actualRevision: state.revision,
      },
    };
  }

  if (mutation.ops.length === 0) {
    return { ok: false, error: { type: "empty-batch" } };
  }
  if (mutation.ops.length > MAX_MUTATION_OPS) {
    return {
      ok: false,
      error: {
        type: "batch-too-large",
        reason: `mutation has ${mutation.ops.length} ops, exceeding the limit of ${MAX_MUTATION_OPS}`,
      },
    };
  }

  // copy-on-write: draft is a shallow copy of state.files, and every step while applying only
  // touches draft, never state itself -- if this function returns early, the caller still has
  // exactly the state it originally passed in, with zero partial writes.
  const draft = new Map(state.files);
  let totalBytes = 0;

  for (const op of mutation.ops) {
    const classification = classifyWorkspacePath(op.path);
    if (!classification.ok) {
      return { ok: false, error: { type: "invalid-path", path: op.path, reason: classification.reason } };
    }

    if (op.op === "delete") {
      if (!draft.has(op.path)) {
        return { ok: false, error: { type: "invalid-path", path: op.path, reason: "delete target does not exist" } };
      }
      draft.delete(op.path);
      continue;
    }

    // op.op === "write"
    if (op.kind !== classification.kind) {
      return {
        ok: false,
        error: {
          type: "type-mismatch",
          path: op.path,
          reason: `path classified as "${classification.kind}", but the write declared "${op.kind}"`,
        },
      };
    }
    if (op.kind === "text" && typeof op.text !== "string") {
      return { ok: false, error: { type: "type-mismatch", path: op.path, reason: "the text field of a text write is not a string" } };
    }
    if (op.kind === "blob" && !(op.bytes instanceof Uint8Array)) {
      return { ok: false, error: { type: "type-mismatch", path: op.path, reason: "the bytes field of a blob write is not a Uint8Array" } };
    }

    const file: WorkspaceFile =
      op.kind === "text"
        ? { kind: "text", path: op.path, text: op.text }
        : { kind: "blob", path: op.path, bytes: op.bytes.slice() }; // defensive copy, isolates against the caller later mutating the original buffer
    const size = byteLengthOf(file);
    const limit = op.kind === "text" ? MAX_TEXT_FILE_BYTES : MAX_BLOB_FILE_BYTES;
    if (size > limit) {
      return {
        ok: false,
        error: { type: "size-exceeded", path: op.path, reason: `${size} bytes exceeds the per-file limit of ${limit} bytes` },
      };
    }

    totalBytes += size;
    if (totalBytes > MAX_MUTATION_TOTAL_BYTES) {
      return {
        ok: false,
        error: {
          type: "batch-too-large",
          reason: `mutation batch total is ${totalBytes} bytes, exceeding the limit of ${MAX_MUTATION_TOTAL_BYTES} bytes`,
        },
      };
    }

    draft.set(op.path, file);
  }

  return { ok: true, plan: { nextFiles: draft, nextRevision: state.revision + 1 } };
}
