// Pure type definitions for the workspace virtual file tree. Zero external
// dependencies, zero browser APIs -- shared across the domain rules (paths.ts/mutate.ts),
// the port (../ports.ts), the in-memory implementation (../testing/fakes.ts), and the
// IndexedDB adapter, so both sides can run the same contract tests (contract.ts).

/** File content splits into two kinds: text (YAML/JSON/plain text, UTF-8) and blob (media
 * bytes). The classification is decided by the path rules (paths.ts) based on path/extension
 * -- it's not a flag callers can freely declare. This is part of the allowlist's spirit:
 * a caller can't force media/*.png to be called text to bypass validation, and vice versa
 * (mutate.ts's planMutation compares the declared kind against the path's classification;
 * a mismatch is a type-mismatch). */
export type WorkspaceContentKind = "text" | "blob";

export interface WorkspaceFileText {
  readonly kind: "text";
  readonly path: string;
  readonly text: string;
}

export interface WorkspaceFileBlob {
  readonly kind: "blob";
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type WorkspaceFile = WorkspaceFileText | WorkspaceFileBlob;

/** The lightweight entry used by list() -- does not include content itself (read content via
 * readFile(path)). */
export interface WorkspaceEntry {
  readonly path: string;
  readonly kind: WorkspaceContentKind;
  readonly byteLength: number;
}

/** The shape list() returns: the workspace's current revision + a lightweight list of every
 * file. */
export interface WorkspaceSnapshot {
  readonly revision: number;
  readonly entries: readonly WorkspaceEntry[];
}

export type WorkspaceWriteOp =
  | { readonly op: "write"; readonly path: string; readonly kind: "text"; readonly text: string }
  | { readonly op: "write"; readonly path: string; readonly kind: "blob"; readonly bytes: Uint8Array }
  | { readonly op: "delete"; readonly path: string };

/** A single atomic mutation: a batch of ops does OCC against one expectedRevision -- it only
 * lands if every op is legal; if any single op is illegal (path, type, size, revision), the
 * whole batch is rejected and the workspace state is left exactly as it was (zero partial
 * writes). There is no piecemeal API for writing files one at a time in real time --
 * atomicity is this API's own responsibility, not something callers need to wrap in their
 * own transaction. */
export interface WorkspaceMutation {
  readonly expectedRevision: number;
  readonly ops: readonly WorkspaceWriteOp[];
}

export type WorkspaceMutationError =
  | { readonly type: "revision-conflict"; readonly expectedRevision: number; readonly actualRevision: number }
  | { readonly type: "invalid-path"; readonly path: string; readonly reason: string }
  | { readonly type: "type-mismatch"; readonly path: string; readonly reason: string }
  | { readonly type: "size-exceeded"; readonly path: string; readonly reason: string }
  | { readonly type: "empty-batch" }
  | { readonly type: "batch-too-large"; readonly reason: string };

export type WorkspaceMutationResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly error: WorkspaceMutationError };

/** The "current state" snapshot used internally by mutate() for planning -- port
 * implementations (memory/IndexedDB) represent their own internal storage as this shape and
 * feed it to planMutation(); the pure function neither knows nor cares whether a Map or an
 * IDB object store is behind it. */
export interface WorkspaceState {
  readonly revision: number;
  readonly files: ReadonlyMap<string, WorkspaceFile>;
}
