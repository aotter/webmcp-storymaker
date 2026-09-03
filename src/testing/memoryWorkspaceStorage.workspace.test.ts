// Runs the WorkspaceStoragePort contract test suite (../workspace/contract.ts)
// against MemoryWorkspaceStorage. For another storage backend, add a matching
// file that imports the same describeWorkspaceStorageContract() with a new factory — the
// contract itself doesn't need to be rewritten.
import { describeWorkspaceStorageContract } from "../workspace/contract.ts";
import { MemoryWorkspaceStorage } from "./fakes.ts";

describeWorkspaceStorageContract("MemoryWorkspaceStorage", () => new MemoryWorkspaceStorage());
