// Deterministic "inject a concurrent write mid-read" test wrapper — originally lived inside an
// archival-export module that has since been removed entirely along with the hand-authoring UI;
// two current call sites, ../story/contract.ts and
// ../webmcp/tools/readonlyTools.webmcp.test.ts, still need this same torn-read test technique,
// so it moved into src/testing/ (same reason as ./gateableStorage.ts and the other existing test
// utilities there: import paths don't need to escape src/, and the dependency-boundary check
// only scans src/**) instead of disappearing along with that module.
import type { WorkspaceStoragePort } from "../ports.ts";

/**
 * Wraps a WorkspaceStoragePort and injects a concurrent, actually-landed mutate() call at the
 * moment readFile() is invoked — simulating the race where another tab/flow really does mutate
 * the workspace mid-read. `maxInjections` controls how many times to inject: 1 means inject only
 * once (subsequent retries see no further interference and should converge to success);
 * `Number.POSITIVE_INFINITY` means inject on every readFile() call (concurrent changes never
 * stop, so retries never catch up and it should exhaust its retry budget and return
 * workspace-busy).
 */
export class RaceInjectingStorage implements WorkspaceStoragePort {
  #remaining: number;

  constructor(
    private readonly inner: WorkspaceStoragePort,
    private readonly injectMutation: () => Promise<void>,
    maxInjections: number,
  ) {
    this.#remaining = maxInjections;
  }

  open(): Promise<void> {
    return this.inner.open();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  list(): ReturnType<WorkspaceStoragePort["list"]> {
    return this.inner.list();
  }

  mutate(mutation: Parameters<WorkspaceStoragePort["mutate"]>[0]): ReturnType<WorkspaceStoragePort["mutate"]> {
    return this.inner.mutate(mutation);
  }

  async readFile(path: string): ReturnType<WorkspaceStoragePort["readFile"]> {
    if (this.#remaining > 0) {
      this.#remaining--;
      await this.injectMutation();
    }
    return this.inner.readFile(path);
  }
}
