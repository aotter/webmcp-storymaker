// Runs the same readiness contract tests
// (../story/readiness.contract.ts) against IndexedDbWorkspaceStorage as the
// memory version (../testing/memoryWorkspaceStorage.readiness.workspace.test.ts)
// -- the same contract runs against both the memory and IndexedDB backends.
//
// Each test case needs its own isolated fake database, for the same reason
// and in the same way as indexeddbWorkspaceStorage.story.workspace.test.ts:
// the factory builds a brand new `IDBFactory()` on every call.
import { IDBFactory } from "fake-indexeddb";
import { describeReadinessContract } from "../story/readiness.contract.ts";
import { IndexedDbWorkspaceStorage } from "./indexeddbWorkspaceStorage.ts";

describeReadinessContract(
  "IndexedDbWorkspaceStorage",
  () => new IndexedDbWorkspaceStorage({ indexedDB: new IDBFactory(), dbName: "readiness-contract-test" }),
);
