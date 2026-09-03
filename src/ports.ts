// Port definitions for a swappable composition root.
//
// Principle (see docs/architecture.md): each port only holds what
// tests actually call — the complete API shape (the real payload shape for
// WebMCP tool registration, etc.) is added only when it's actually needed; nothing
// is pre-invented here.
//
// WorkspaceStoragePort was expanded from "just open/close" into a full virtual
// file tree API — the choice to expand the existing port rather than open a second one to
// compose alongside it is because open/close describe the lifecycle of "this workspace storage
// backend," and list/readFile/mutate describe the same backend's read/write capabilities — two
// facets of the same concept, not two separate concerns. The composition root (app.ts), the
// production adapter (adapters.ts), and the test fake (testing/fakes.ts) all only need to inject
// a single storage instance; there's no reason to split it into two ports and make callers
// assemble them themselves. See ./workspace/types.ts for the type definitions
// (WorkspaceFile/WorkspaceSnapshot/WorkspaceMutation/WorkspaceMutationResult).
import type { WorkspaceFile, WorkspaceMutation, WorkspaceMutationResult, WorkspaceSnapshot } from "./workspace/types.ts";

/**
 * Workspace storage backend: a virtual path -> text/blob file tree, plus a revision
 * (docs/architecture.md).
 *
 * The read side deliberately has only "read one file" and "list everything," and the write side
 * deliberately has only one "single atomic mutation" — there's no piecemeal API for writing
 * individual files immediately. Atomicity/allowlisting/revision validation are all concentrated
 * in this one mutate() entry point; callers don't need (and in fact can't) hand-roll a
 * "validate then write" sequence to bypass these guarantees.
 *
 * Path validity and mutation validation logic are themselves pure functions
 * (./workspace/paths.ts, ./workspace/mutate.ts) — this port is only an abstraction over "which
 * backend." The reference implementation is memory-based
 * (testing/fakes.ts's MemoryWorkspaceStorage); when the IndexedDB adapter is swapped in,
 * this interface's shape stays the same — only the underlying storage changes.
 */
export interface WorkspaceStoragePort {
  open(): Promise<void>;
  close(): Promise<void>;

  /** The current full listing: revision plus each file's path/kind/byteLength (not the content
   * itself). */
  list(): Promise<WorkspaceSnapshot>;

  /** Reads the full content of a single file. Returns undefined if the path is invalid or the
   * file doesn't exist — callers that want to validate path legitimacy should call
   * ./workspace/paths.ts's classifyWorkspacePath directly; this method only answers "is there
   * content to read right now." */
  readFile(path: string): Promise<WorkspaceFile | undefined>;

  /** A single atomic mutation: a batch of write/delete ops against one expectedRevision, using
   * OCC. Everything lands only if all of it is valid; if even one op is invalid (path, type,
   * size, revision), the whole batch is rejected and workspace state is left completely
   * untouched — zero partial writes. */
  mutate(mutation: WorkspaceMutation): Promise<WorkspaceMutationResult>;
}

// There used to be a `WebMcpCapabilityPort` here (with only `isAvailable()`) — it was later
// absorbed into `src/webmcp/types.ts`'s `WebMcpPort` (which adds `registerTools()`), and the
// old port was deleted rather than left in this
// file. See src/webmcp/facade.ts's header, "port-absorption rationale," for the reasoning and the
// new type; the composition root (app.ts), the production adapter (main.ts), and the test fake
// (testing/fakes.ts's `FakeWebMcpFacade`) all now import `WebMcpPort`.
