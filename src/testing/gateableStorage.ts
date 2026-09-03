// A fake storage with a controllable (manually
// resolved) promise for deterministic injection, not a timer — living in src/testing/ (same
// reason as src/testing/fakes.ts's header: import
// paths don't need to escape src/, and the dependency-boundary check only scans src/**).
//
// Wraps around any real WorkspaceStoragePort implementation (tests usually wrap
// MemoryWorkspaceStorage), letting a test precisely hold "the next call to a given storage
// method" so it produces a deterministic window where "this storage call hasn't come back yet",
// instead of gambling on execution order or guessing timing with setTimeout.
// ../ui/controller.workspace.test.ts uses it to
// verify hydrate()'s own generation guard (`#hydrateGen`) — it holds one hydrate() call stuck on
// a storage call, lets a newer hydrate() run to completion in the meantime, then releases the
// held one, deterministically reproducing the race where "the older call comes back later," and
// proving it doesn't clobber the newer result.
import type { WorkspaceStoragePort } from "../ports.ts";
import type { WorkspaceFile, WorkspaceMutation, WorkspaceMutationResult, WorkspaceSnapshot } from "../workspace/types.ts";

type GateableMethod = "list" | "readFile" | "mutate";

export class GateableStorage implements WorkspaceStoragePort {
  readonly #inner: WorkspaceStoragePort;
  #gate: { method: GateableMethod; release: Promise<void> } | null = null;

  constructor(inner: WorkspaceStoragePort) {
    this.#inner = inner;
  }

  /** Makes "the next call to `method` on this storage" hang until the returned release() is
   * called — only holds the first `method` call made after this is invoked; once it hits, the
   * gate is cleared immediately, so any later calls (including other storage calls made by, say,
   * a concurrent import while it's held) pass straight through and are never caught by the same
   * gate twice. */
  gateNextCall(method: GateableMethod): () => void {
    let resolve!: () => void;
    const release = new Promise<void>((r) => {
      resolve = r;
    });
    this.#gate = { method, release };
    return resolve;
  }

  async #maybeWait(method: GateableMethod): Promise<void> {
    if (this.#gate?.method !== method) return;
    const { release } = this.#gate;
    this.#gate = null;
    await release;
  }

  async open(): Promise<void> {
    return this.#inner.open();
  }

  async close(): Promise<void> {
    return this.#inner.close();
  }

  async list(): Promise<WorkspaceSnapshot> {
    await this.#maybeWait("list");
    return this.#inner.list();
  }

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    await this.#maybeWait("readFile");
    return this.#inner.readFile(path);
  }

  async mutate(mutation: WorkspaceMutation): Promise<WorkspaceMutationResult> {
    await this.#maybeWait("mutate");
    return this.#inner.mutate(mutation);
  }
}
