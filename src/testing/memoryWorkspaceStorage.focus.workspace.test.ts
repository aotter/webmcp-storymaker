// Runs the focus contract test suite (../story/focus.contract.ts) against
// MemoryWorkspaceStorage. Same reason as memoryWorkspaceStorage.story.workspace.test.ts — the
// same set of behavior assertions applied to two implementations of this port, without
// rewriting the contract itself.
import { describeFocusContract } from "../story/focus.contract.ts";
import { MemoryWorkspaceStorage } from "./fakes.ts";

describeFocusContract("MemoryWorkspaceStorage", () => new MemoryWorkspaceStorage());
