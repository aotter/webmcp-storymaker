// Runs the story-operations-layer contract test suite (../story/contract.ts) against
// MemoryWorkspaceStorage. Same reason as memoryWorkspaceStorage.workspace.test.ts — the same set
// of behavior assertions applied across multiple contracts for this port, without rewriting the
// contract itself.
import { describeStoryContract } from "../story/contract.ts";
import { MemoryWorkspaceStorage } from "./fakes.ts";

describeStoryContract("MemoryWorkspaceStorage", () => new MemoryWorkspaceStorage());
