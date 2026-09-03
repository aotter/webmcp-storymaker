// Test memory fakes, kept importable from src/testing/ (see README.md). A fake is a
// first-class citizen — every fake must be able to observe the outcome of an interaction
// (whether it opened, whether it closed, what it received): tests verify observable outcomes,
// not just assert that a function was called.
//
// MemoryWorkspaceStorage is a real reference implementation of WorkspaceStoragePort — it's the
// backend used before the IndexedDB adapter is available, and it's also the
// test subject for the
// ../workspace/contract.ts contract test suite. Path allowlisting, mutation validation, and
// atomicity are all delegated to the pure functions in ../workspace/paths.ts and
// ../workspace/mutate.ts — this class is only responsible for applying the pure functions'
// planned result to an in-memory Map.
import type { WorkspaceStoragePort } from "../ports.ts";
import type { WebMcpPort, WebMcpRegistration, WebMcpToolDefinition } from "../webmcp/index.ts";
import { planMutation } from "../workspace/mutate.ts";
import type {
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceMutation,
  WorkspaceMutationResult,
  WorkspaceSnapshot,
  WorkspaceState,
} from "../workspace/types.ts";

const textEncoder = new TextEncoder();

function byteLengthOf(file: WorkspaceFile): number {
  return file.kind === "text" ? textEncoder.encode(file.text).length : file.bytes.length;
}

/**
 * Memory-only reference implementation of WorkspaceStoragePort. open()/close() flip an
 * observable flag (`isOpen`) — tests use it to prove that the composition root's start/stop
 * semantics really do call into the port. list/readFile/mutate are a genuinely functional
 * virtual file tree (nothing is persisted to any real storage — closing the tab/reloading loses
 * it; persistence is the scope of the IndexedDB adapter).
 */
export class MemoryWorkspaceStorage implements WorkspaceStoragePort {
  #open = false;
  #revision = 0;
  #files = new Map<string, WorkspaceFile>();

  async open(): Promise<void> {
    this.#open = true;
  }

  async close(): Promise<void> {
    this.#open = false;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  async list(): Promise<WorkspaceSnapshot> {
    const entries: WorkspaceEntry[] = [...this.#files.values()]
      .map((file) => ({ path: file.path, kind: file.kind, byteLength: byteLengthOf(file) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return { revision: this.#revision, entries };
  }

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    const file = this.#files.get(path);
    if (!file) return undefined;
    // Defensive copy: the returned blob bytes are not the same Uint8Array as the internal
    // storage — a caller mutating what it read back can't secretly corrupt workspace state (the
    // only legitimate write path is mutate()).
    return file.kind === "blob" ? { ...file, bytes: file.bytes.slice() } : file;
  }

  async mutate(mutation: WorkspaceMutation): Promise<WorkspaceMutationResult> {
    const state: WorkspaceState = { revision: this.#revision, files: this.#files };
    const result = planMutation(state, mutation);
    if (!result.ok) return { ok: false, error: result.error };
    // Only swap the internal state once planning fully succeeds — planMutation itself never
    // applies partially, so "swap only on success" needs no extra rollback logic.
    this.#files = new Map(result.plan.nextFiles);
    this.#revision = result.plan.nextRevision;
    return { ok: true, revision: this.#revision };
  }
}

/**
 * A simplified `WebMcpPort` fake — for callers that only care about the "is WebMCP
 * available" boolean and don't need to verify the fine-grained registerTool()/abort semantics
 * (composition-root-level tests, see app.workspace.test.ts). Replaces an earlier
 * `FakeWebMcpCapability` (which only had `isAvailable()`) — see
 * ../webmcp/facade.ts's header, "port-absorption rationale," for why.
 *
 * To test the real registerTool/schema/execute/abort behavior, use
 * ./fakeModelContext.ts's `FakeModelContext` together with ../webmcp/facade.ts's
 * `DomWebMcpFacade` instead of this one — this class's `registerTools()` deliberately doesn't
 * simulate name collisions, abort races, or other edge cases; it only preserves this port's core
 * contract (zero registrations when unavailable, observable dispose).
 */
export class FakeWebMcpFacade implements WebMcpPort {
  /** The defs received by each registerTools() call, in call order — removed once dispose() is
   * called. */
  readonly registrations: (readonly WebMcpToolDefinition[])[] = [];

  constructor(private readonly available: boolean) {}

  isAvailable(): boolean {
    return this.available;
  }

  registerTools(defs: readonly WebMcpToolDefinition[]): WebMcpRegistration {
    if (!this.available) return { ready: Promise.resolve(), dispose: async () => {} };

    const batch = defs;
    this.registrations.push(batch);
    let disposed = false;
    return {
      ready: Promise.resolve(),
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        const idx = this.registrations.indexOf(batch);
        if (idx !== -1) this.registrations.splice(idx, 1);
      },
    };
  }
}
