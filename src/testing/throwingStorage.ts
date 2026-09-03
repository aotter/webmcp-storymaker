// Work queued via `#enqueueWrite()` sometimes
// doesn't return a structured `ok:false` but throws directly (e.g. `crypto.subtle` not existing
// in a non-secure context, or the IndexedDB adapter throwing an unexpected exception) — this
// fake lets a test deterministically reproduce "the storage call itself throws" without actually
// breaking the environment or guessing when the underlying adapter will blow up.
//
// Wraps around any real WorkspaceStoragePort implementation (same existing convention as
// ./gateableStorage.ts, and the same reason it lives in src/testing/ — import paths don't need
// to escape src/, and the dependency-boundary check only scans src/**).
import type { WorkspaceStoragePort } from "../ports.ts";
import type { WorkspaceFile, WorkspaceMutation, WorkspaceMutationResult, WorkspaceSnapshot } from "../workspace/types.ts";

type ThrowableMethod = "list" | "readFile" | "mutate";

export class ThrowingStorage implements WorkspaceStoragePort {
  readonly #inner: WorkspaceStoragePort;
  #throwOn: ThrowableMethod | null = null;

  constructor(inner: WorkspaceStoragePort) {
    this.#inner = inner;
  }

  /** Makes "the next call to `method` on this storage" throw directly (`Error`) — affects only
   * the next call; once hit it's cleared immediately, so it won't misfire a second time (same
   * one-shot semantics as GateableStorage.gateNextCall). */
  throwOnNextCall(method: ThrowableMethod): void {
    this.#throwOn = method;
  }

  #maybeThrow(method: ThrowableMethod): void {
    if (this.#throwOn !== method) return;
    this.#throwOn = null;
    throw new Error(`ThrowingStorage: simulated an unexpected exception thrown from ${method}()`);
  }

  async open(): Promise<void> {
    return this.#inner.open();
  }

  async close(): Promise<void> {
    return this.#inner.close();
  }

  async list(): Promise<WorkspaceSnapshot> {
    this.#maybeThrow("list");
    return this.#inner.list();
  }

  async readFile(path: string): Promise<WorkspaceFile | undefined> {
    this.#maybeThrow("readFile");
    return this.#inner.readFile(path);
  }

  async mutate(mutation: WorkspaceMutation): Promise<WorkspaceMutationResult> {
    this.#maybeThrow("mutate");
    return this.#inner.mutate(mutation);
  }
}
