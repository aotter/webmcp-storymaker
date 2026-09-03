// Runs the same WorkspaceStoragePort contract tests
// (../workspace/contract.ts) against IndexedDbWorkspaceStorage as the memory
// version (../testing/memoryWorkspaceStorage.workspace.test.ts) -- the same
// behavioral assertions applied to the IndexedDB backend, without rewriting
// the contract itself.
//
// Each test case needs its own isolated fake database, so the factory builds
// a brand new `IDBFactory()` on every call (the "reset" technique
// fake-indexeddb provides -- see the package README) -- this way no case's
// data can ever leak into the next case, the same isolation level as
// `() => new MemoryWorkspaceStorage()` handing out a fresh Map every time.
import { IDBFactory } from "fake-indexeddb";
import { describeWorkspaceStorageContract } from "../workspace/contract.ts";
import { IndexedDbWorkspaceStorage } from "./indexeddbWorkspaceStorage.ts";

describeWorkspaceStorageContract(
  "IndexedDbWorkspaceStorage",
  () => new IndexedDbWorkspaceStorage({ indexedDB: new IDBFactory(), dbName: "contract-test" }),
);
