// Type definitions for the WebMCP capability facade.
//
// This file is where the red line "don't scatter WebMCP types into the domain/storage layer"
// lands -- the native type declarations for
// `document.modelContext` (there's nothing in the TS standard library for this; WebMCP is still
// at the W3C draft stage) only ever appear inside src/webmcp/**, using the pattern
// `Document & { modelContext?: ... }` for `WebMcpDocument`. The WebMCP tool
// implementations only import this file's exports (via the ./index.ts barrel) of
// `WebMcpToolDefinition`/`WebMcpPort`/`WebMcpRegistration`; they never touch, and never need to
// touch, the native types like `ModelContextTool` below.
//
// The type shapes are checked against the W3C WebMCP spec (webmachinelearning/webmcp's
// `index.bs`, 2026-08 snapshot), transcribing only the subset this facade actually uses
// (`registerTool()` and its options/tool dictionary), not transcribing methods like
// `getTools()`/`executeTool()` that this phase doesn't need -- extend it later when needed,
// don't over-translate the spec ahead of time:
//   - `registerTool(tool, options)`: `options.signal` is an `AbortSignal`; on abort, the tool is
//     unregistered and that `registerTool()` call's promise rejects with the abort reason (per
//     the spec's `ModelContext/registerTool()` algorithm's "Add abort steps: unregister tool +
//     reject promise").
//   - `ModelContextTool.annotations.readOnlyHint`: a hint the agent uses to decide "is it safe to
//     call this tool freely," corresponding to this file's `WebMcpToolDefinition.readOnlyHint`.
//   - The same registration shape is used by the browser integrations this app supports:
//     `registerTool(tool, { signal })`, returning a `dispose()` for unmount.

/** A hint about a tool's read-only-ness/content trustworthiness, corresponding to the spec's
 * `ToolAnnotations` dictionary. `readOnlyHint`: this tool only reads, never writes, so the agent
 * can call it with more confidence (the 3.2 read-only tools mark this true). `untrustedContentHint`:
 * this tool's returned content isn't trustworthy (e.g. it relays user input). No caller in this
 * phase needs it -- the type just reserves a spot so 3.2/3.3 won't have to come back and edit this
 * file when they need it. */
export interface WebMcpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly untrustedContentHint?: boolean;
}

/** The options a tool receives when it executes -- currently just the abort signal (the spec's
 * `ToolExecuteCallbackOptions`).
 *
 * **Documentation-gap correction**: this `signal` is **created independently, on each call**, by the host (the
 * browser/agent runtime) whenever it calls `executeTool()` -- it has a completely different
 * lifecycle from the signal used when `WebMcpPort.registerTools()` registered this tool, and the
 * two have no relationship to each other. This means: **`WebMcpRegistration.dispose()` neither
 * does, nor has any mechanism to, cancel an `execute()` call already in flight** -- dispose only
 * deregisters the tool from modelContext (so the agent can no longer "call" it afterward), it
 * doesn't interrupt a call that's already running. A tool's `execute` implementation therefore
 * has to shoulder two things itself:
 *   1. Its own call could be cancelled by the agent side -- watch this `signal` and stop when it
 *      aborts.
 *   2. While the call is in progress, "the world" may already have been disposed/replaced (e.g.
 *      the story was switched, the workspace was reloaded) -- it can't assume the facade blocks
 *      this for it; it has to rely on the story/workspace layer's existing OCC/`expectedRevision`
 *      defenses (see `WorkspaceStoragePort.mutate()` in `../ports.ts`) to naturally reject a
 *      now-stale assumption at write time, not on this `signal` here. */
export interface WebMcpToolExecuteOptions {
  readonly signal: AbortSignal;
}

/** The facade's own tool definition type -- 3.2/3.3 describe tools with this shape, never
 * touching the native `ModelContextTool` directly (see the file header). `execute`'s `input` is
 * deliberately typed `unknown`, leaving validation/narrowing to each tool's own implementation --
 * a tool's `inputSchema` is only a contract for the agent to read, not a runtime type guarantee.
 * **`dispose()` does not cancel an `execute()` call in flight** -- see the `WebMcpToolExecuteOptions`
 * docs above for the details and the responsibility this places on implementers. */
export interface WebMcpToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema?: object;
  readonly annotations?: WebMcpToolAnnotations;
  execute(input: unknown, options: WebMcpToolExecuteOptions): Promise<unknown>;
}

/** The aggregate error `ready` rejects with when `WebMcpPort.registerTools()`'s batch
 * registration fails -- lists, for every tool in this batch that "genuinely failed to register"
 * (not one that was aborted merely because we ourselves called `dispose()`), its name plus the
 * original failure reason (see the "same-name
 * registration across batches" note in the header of ./facade.ts): the caller must be able to
 * tell from here which tools didn't mount and why -- it can't be flattened into an uninformative
 * success signal. */
export class WebMcpRegistrationError extends Error {
  readonly failures: readonly { readonly name: string; readonly reason: unknown }[];

  constructor(failures: readonly { readonly name: string; readonly reason: unknown }[]) {
    super(
      `WebMcpPort.registerTools(): ${failures.length} tool(s) failed to register, the whole batch was rolled back (${failures
        .map((f) => f.name)
        .join(", ")})`,
    );
    this.name = "WebMcpRegistrationError";
    this.failures = failures;
  }
}

/** The registration result for a batch of tools -- `WebMcpPort.registerTools()` returns this
 * synchronously, without waiting for every underlying `registerTool()` call to actually land
 * (that part is asynchronous by design; see the header of ./facade.ts for why).
 *
 * `ready`: resolves only once **every** tool in this batch has genuinely registered
 * successfully. Any single genuine failure (e.g. a name collision with a tool already mounted by
 * another batch) makes `ready` reject, with a `WebMcpRegistrationError` (naming which tools, and
 * why) -- it is **never** silently flattened into a fake success signal (see the header of
 * ./facade.ts). When a genuine failure happens, the rest of this
 * batch's already-mounted tools are automatically rolled back (the whole batch deregisters
 * together), leaving no half-mounted intermediate state.
 *
 * Exception: if the only "failure" in this batch is an abort caused by us calling `dispose()`
 * ourselves (a cancellation mid-unmount/reload -- a legitimate cancellation, not a failure),
 * `ready` keeps its existing semantics and just resolves -- it won't report what looks like a
 * "failure" rejection just because the caller cancelled on its own.
 *
 * `dispose()`: deregisters this batch's tools, and only resolves **after** every still-in-flight
 * `registerTool()` call has settled -- this is the concrete guarantee behind "dispose must never
 * leave a pending Promise behind," so the caller
 * (especially a UI unmount/reload) doesn't have to handle the race of "aborted, but the
 * underlying promise hasn't actually resolved yet" itself. **`dispose()` itself never rejects
 * just because this batch's registration failed** -- it only guarantees "nothing is still
 * hanging," it isn't responsible for reporting this batch's success or failure (that's `ready`'s
 * job; the two are deliberately kept separate, see the header of ./facade.ts). Idempotent:
 * calling it repeatedly is safe. */
export interface WebMcpRegistration {
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

/** An earlier `WebMcpCapabilityPort` (just `isAvailable()`) is absorbed into this type --
 * see the "port-absorption rationale" note in the header of src/webmcp/facade.ts. The
 * composition root (app.ts), the production adapter (main.ts), and the test fakes (testing/fakes.ts's
 * `FakeWebMcpFacade`, testing/fakeModelContext.ts's `FakeModelContext`) all only ever know this
 * one type. */
export interface WebMcpPort {
  /** The progressive-enhancement detection from docs/architecture.md: does this environment
   * currently have a `document.modelContext` to mount onto. */
  isAvailable(): boolean;
  /** Mounts a batch of tool definitions onto WebMCP. Registers nothing when there's no
   * capability (returns a registration that does nothing), never throws -- the caller doesn't
   * need to check `isAvailable()` itself first before deciding whether to call this. */
  registerTools(defs: readonly WebMcpToolDefinition[]): WebMcpRegistration;
}

// ---- Below: native type declarations for document.modelContext, used only inside src/webmcp/** ----

/** A subset of the spec's `ModelContextRegisterToolOptions` dictionary -- this facade only ever
 * needs `signal`; it doesn't transcribe `exposedTo` (cross-iframe exposure scope, which no caller
 * in this phase needs). */
export interface ModelContextRegisterToolOptions {
  readonly signal?: AbortSignal;
}

/** The options the native execute receives -- **deliberately kept separate** from the internal
 * `WebMcpToolExecuteOptions`: a real-browser regression test (the ChatGPT desktop app's
 * built-in browser, 2026-09) found that a real host calls `execute()` **without a signal**
 * (the spec's `ToolExecuteCallbackOptions` can't be treated as a host guarantee) -- the first
 * tool to read `signal.aborted` would reject with a native TypeError, bypassing the safe DTO. So
 * everything on the host side of this shape is optional, and facade.ts's `toModelContextTool()`
 * normalizes it at the boundary into the internal guarantee (signal is always present); the tool
 * implementations continue to only ever see `WebMcpToolExecuteOptions`. */
export interface ModelContextToolExecuteOptions {
  readonly signal?: AbortSignal;
}

/** The spec's `ModelContextTool` dictionary -- the shape the native `registerTool()` takes,
 * produced by facade.ts's `toModelContextTool()` converting from `WebMcpToolDefinition`, never
 * exposed directly to 3.2/3.3's callers. */
export interface ModelContextTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema?: object;
  readonly annotations?: WebMcpToolAnnotations;
  execute(input: unknown, options?: ModelContextToolExecuteOptions): Promise<unknown>;
}

/** A subset of the spec's `ModelContext` interface -- this facade only ever needs
 * `registerTool()` (`getTools()`/`executeTool()` have no caller in this phase, so they aren't
 * transcribed ahead of time). */
export interface WebMcpModelContext {
  registerTool(tool: ModelContextTool, options?: ModelContextRegisterToolOptions): Promise<void>;
}

/** Follows the same `WebMcpDocument` technique as spike-webmcp-companion: `Document` plus a
 * `modelContext` that might not exist. */
export type WebMcpDocument = Document & { modelContext?: WebMcpModelContext };
