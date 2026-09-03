// Runs the readiness contract test suite (../story/readiness.contract.ts) against
// MemoryWorkspaceStorage. Same reason as memoryWorkspaceStorage.story.workspace.test.ts — the
// same set of behavior assertions applied to two implementations of this port, without
// rewriting the contract itself.
import { describeReadinessContract } from "../story/readiness.contract.ts";
import { MemoryWorkspaceStorage } from "./fakes.ts";

describeReadinessContract("MemoryWorkspaceStorage", () => new MemoryWorkspaceStorage());
