// Runs the same story-operation-layer contract tests
// (../story/contract.ts) against IndexedDbWorkspaceStorage as the memory
// version (../testing/memoryWorkspaceStorage.story.workspace.test.ts) --
// story-layer tests run as a contract against both memory and IndexedDB.
//
// Each test case needs its own isolated fake database, for the same reason
// and in the same way as indexeddbWorkspaceStorage.workspace.test.ts: the
// factory builds a brand new `IDBFactory()` on every call.
import { IDBFactory } from "fake-indexeddb";
import { describeStoryContract } from "../story/contract.ts";
import { IndexedDbWorkspaceStorage } from "./indexeddbWorkspaceStorage.ts";

describeStoryContract(
  "IndexedDbWorkspaceStorage",
  () => new IndexedDbWorkspaceStorage({ indexedDB: new IDBFactory(), dbName: "story-contract-test" }),
);
