// Runs the same focus contract tests (../story/focus.contract.ts)
// against IndexedDbWorkspaceStorage as the memory version
// (../testing/memoryWorkspaceStorage.focus.workspace.test.ts).
//
// Each test case needs its own isolated fake database, for the same reason
// and in the same way as indexeddbWorkspaceStorage.story.workspace.test.ts:
// the factory builds a brand new `IDBFactory()` on every call.
import { IDBFactory } from "fake-indexeddb";
import { describeFocusContract } from "../story/focus.contract.ts";
import { IndexedDbWorkspaceStorage } from "./indexeddbWorkspaceStorage.ts";

describeFocusContract(
  "IndexedDbWorkspaceStorage",
  () => new IndexedDbWorkspaceStorage({ indexedDB: new IDBFactory(), dbName: "focus-contract-test" }),
);
