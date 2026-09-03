// The WebMCP capability facade itself -- centralizes feature detection, tool
// registration/deregistration, and abort cleanup. This file is the only
// place in this repo that calls `document.modelContext.registerTool()`; the WebMCP tool
// implementations mount tools only through `WebMcpPort.registerTools()`, never touching
// `document.modelContext` directly.
//
// ## Port-absorption rationale
//
// An earlier `WebMcpCapabilityPort` (just `isAvailable()`) is absorbed entirely into this file's
// `WebMcpPort` (defined in ./types.ts) -- rather than keeping two ports (`WebMcpCapabilityPort`
// for pure detection plus a separate facade port for registration):
//
//   - `isAvailable()` and `registerTools()` describe two facets of the same underlying resource
//     (`document.modelContext`), the same reasoning that merged `WorkspaceStoragePort`'s
//     open/close with list/readFile/mutate (see the header of ports.ts) -- there's no reason to
//     open two ports for "detecting" versus "using," and the
//     composition root never has a scenario where it needs only detection without eventually
//     registering for real.
//   - Splitting them into two ports would only manufacture a false degree of freedom where
//     "app.ts has to inject two things, but they always show up as a pair, always pointing at the
//     same `document.modelContext`," and it would give the WebMCP tools layer an extra question
//     of whether to use the second port -- this repo's principle of "each port only carries what
//     tests actually call" (see the header of ports.ts) cuts the other way here too: no caller
//     needs detection and registration injected separately.
//
// So the earlier `WebMcpCapabilityPort` (ports.ts), `DomWebMcpCapability` (adapters.ts), and
// `FakeWebMcpCapability` (testing/fakes.ts) are all deleted wholesale, replaced by this file's
// `WebMcpPort`/`DomWebMcpFacade` and testing/fakes.ts's `FakeWebMcpFacade`; `AppPorts.capability`
// is also renamed to `AppPorts.webMcp` (the field name "capability" fit when it only did
// detection -- now that it's the injection point for the whole WebMCP lifecycle, the rename
// reflects its actual responsibility, see ../app.ts).
//
// ## The design of registerTools()/dispose()
//
// `registerTools()` is a synchronous function, not `async` -- the returned `WebMcpRegistration`
// object (with its `dispose()`) is already usable before any underlying `registerTool()` call has
// actually resolved. This is deliberate: a common bug shape for callers (especially a UI unmount
// effect) is "await registration to finish before you can get dispose, but unmount happens before
// registration finishes, so dispose has nowhere to hook in" -- this facade collapses that race
// away; unmount always has a `dispose()` to call, whether or not the underlying registration has
// finished.
//
// Internally, one `AbortController` wraps each batch of `registerTools()` calls -- every
// `registerTool()` call takes the same
// `controller.signal`, so `dispose()` only needs to call `controller.abort()` once to deregister
// all the tools together (per spec: when the signal aborts, the tool is unregistered, and that
// `registerTool()` call's promise rejects with the abort reason, see the spec excerpt quoted in
// the header of ./types.ts).
//
// ## A same-name registration across batches must not be silently swallowed
//
// An earlier implementation attached `.then(ok, ok)` to every `registerTool()` call
// immediately, folding both success and failure down to `undefined` regardless -- this design was
// meant to guarantee "dispose never leaves a pending promise behind," but the cost was **any
// genuine registration failure got flattened along with it**. The sequence that reproduces the
// bug: batch1 mounts `story.write` (a stale closure, the caller forgot to
// dispose) -> batch2 registers a tool with the same name -> per spec, modelContext rejects
// directly (a name collision) -> the old implementation's `.then(ok, ok)` flattens this rejection
// down to `undefined` too -> `batch2.ready` **falsely resolves as if it succeeded** -> when the
// agent later calls this tool name, it's actually still served by batch1's stale closure, and
// `batch2.dispose()` has zero effect on it (it was never actually mounted). The production
// `WebMcpPort` has no introspection method at all, so at this point the caller has no way to
// detect "what actually got mounted wasn't my batch."
//
// The fix splits "honest external reporting" from "never leave a pending/unhandled promise
// internally" into two independent pipelines:
//
//   1. `allSettled` (internal bookkeeping, never rejects): every `registerTool()` call
//      immediately attaches `.then(okResult, failResult)`, folding both success and failure into
//      a plain object carrying `{ name, ok, reason }` (not discarding the failure information,
//      just never letting it become a rejection). `dispose()` only ever awaits this one promise
//      -- its sole job is "make sure nothing is still hanging," and it must never reject just
//      because some tools in this batch failed, since dispose's caller (usually a UI unmount)
//      shouldn't blow up over "this batch happened to have a few tools that didn't mount."
//   2. `ready` (the honest external signal, which may reject): filters `allSettled`'s results
//      down to "genuine failures" -- excluding the legitimate cancellation of "rejected as a side
//      effect of us calling `dispose()` ourselves" (determined by comparing the rejection's
//      reason against `controller.signal.reason` -- an `AbortController`'s `abort()` only ever
//      takes effect once for the same signal, whether it was triggered by `dispose()` or by the
//      rollback described below, so `signal.reason` is a stable, comparable
//      reference).
//        - No genuine failure (everything succeeded, or the only "failure" was the abort caused
//          by our own dispose) -> `ready` resolves -- a dispose during registration is a
//          legitimate cancellation, not a failure; `ready` keeps its existing (resolve) semantics
//          in this case, neither pretending to fail nor leaving an await hanging forever.
//        - A genuine failure exists -> `ready` rejects, with a `WebMcpRegistrationError` (naming
//          which tools, and the original reason).
//
// ## Rollback rule
//
// When `ready` needs to reject over a genuine failure, the rest of this batch's already-mounted
// tools are automatically rolled back -- by calling the same `controller.abort()` (the one shared
// controller for this batch, not a freshly invented one), which deregisters every tool in this
// batch together (whether it had already succeeded or was still in flight at that moment). The
// reasoning: a half-mounted batch (some tools in this batch serving, some not, with the caller
// having no idea which is which) is the hardest kind of intermediate state to debug -- rolling
// back to "this whole batch didn't mount at all" keeps the failure outcome simple and
// predictable; the caller only has to handle "this whole batch failed, check
// `WebMcpRegistrationError.failures` to decide whether to retry," never having to guess what's
// still alive in this batch. Because every tool in the same batch shares the same
// `controller`/`signal`, the rollback needs no extra per-tool controller tracking -- aborting the
// one shared controller for this batch makes modelContext unregister every tool from this batch
// still on record (the ones that already failed, and were never in the tool map to begin with,
// are a safe no-op).
//
// `dispose()`'s guarantee of "never leaving a pending Promise behind" is unchanged: `dispose()` =
// `controller.abort()` followed by `await allSettled` -- the abort immediately rejects any
// `registerTool()` promise still hanging, and `allSettled` has already caught that rejection (see
// point 1 above), so it's guaranteed to settle, with no unhandled rejection and no orphaned
// promise "aborted but nobody's waiting on it." See ./facade.webmcp.test.ts for the decisive
// verification (relying purely on microtask ordering, no timers).
//
// ## No half-mounted-batch window is left open
//
// The rollback above originally only fired after waiting for the whole batch's attempts to all
// settle via `Promise.all` -- but per spec, `registerTool()` "synchronously writes the tool into
// the tool map first, and only later resolves the promise via a queued task" (see the spec
// excerpt quoted in the header of ./types.ts). That means for a batch of `[good(not yet settled),
// bad(rejects immediately)]`: at the moment `bad`'s genuine failure arrives, `good` might not have
// settled yet -- but it's already been synchronously written into the tool map, and the agent
// **really can call it**. If we still waited for `good` to also settle before triggering the
// rollback, this window of "we already know this batch needs to roll back, but the map hasn't
// been cleaned up yet" would be stretched out longer; worse, if `good` for some reason never
// settles at all, `Promise.all` never completes, and the rollback never happens -- inconsistent
// with this facade's claim of "never leaves a half-mounted batch."
//
// The fix: detect a genuine failure and trigger the rollback without waiting for `Promise.all` --
// instead, **decide the moment each attempt's rejection arrives**: if it's a genuine failure,
// call `controller.abort()` immediately (without waiting for other attempts to settle too). The
// way we decide is unchanged (whether reason equals `controller.signal.reason`), but we
// deliberately don't use "is the signal currently aborted" as the basis for that decision: per
// spec, every rejection point for a "genuine failure" happens synchronously (decided the instant
// `registerTool()` is called -- it's only the timing at which we happen to observe it via
// `.then()` that's staggered), so "the first genuine failure in this batch that we happened to
// observe triggered the abort" doesn't mean "another attempt in this batch that we merely
// happened to observe slightly after that -- but which is actually an independent genuine failure
// of its own" should be misjudged as "collateral damage from the rollback." Only when the reason
// genuinely equals this controller's own abort reason does it count as collateral from the
// rollback, no matter how long the signal has already been aborted for by then. `allSettled` is
// still kept around (dispose() still relies on it to guarantee nothing is left pending); `ready`
// still waits for `allSettled` to finish, then composes every genuine failure accumulated during
// that window into a single `WebMcpRegistrationError` rejection -- but by then the map was
// already cleaned up the instant the first genuine failure was observed, not cleaned up
// on-the-spot right before `ready` rejects.
import type {
  ModelContextTool,
  WebMcpDocument,
  WebMcpPort,
  WebMcpRegistration,
  WebMcpToolDefinition,
} from "./types.ts";
import { WebMcpRegistrationError } from "./types.ts";

/** A stand-in for "the host didn't pass a signal" -- never aborts, one shared instance at the
 * module level is enough. */
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

function toModelContextTool(def: WebMcpToolDefinition): ModelContextTool {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: def.annotations,
    // The normalization boundary for a host's calling conventions (caught by a real-browser
    // regression test, see the `ModelContextToolExecuteOptions` note in types.ts): a real
    // host (the ChatGPT desktop app's built-in browser) calls execute without options/signal, and
    // passing that straight through to `def.execute` would make the tool's very first line,
    // reading `signal.aborted`, reject with a native TypeError, bypassing the safe DTO. This is
    // the single fix point -- the internal contract for all six tools (signal is always present)
    // is unchanged; whatever shape the host actually gives us gets filled in right here.
    execute: (input, options) => def.execute(input, { signal: options?.signal ?? NEVER_ABORTED_SIGNAL }),
  };
}

/** The zero-registration registration used when there's no capability -- `ready` resolves
 * immediately, `dispose()` does nothing (idempotent, safe). This is the single landing spot for
 * docs/architecture.md's "zero registration when WebMCP is absent" -- callers don't need to
 * `if (isAvailable())` themselves before deciding whether to call `registerTools()`. */
const NOOP_REGISTRATION: WebMcpRegistration = {
  ready: Promise.resolve(),
  async dispose() {},
};

/** The progressive-enhancement implementation from docs/architecture.md: mounts tools when
 * `document.modelContext` exists, registers nothing when it doesn't. The constructor takes an
 * injectable `WebMcpDocument | undefined` (defaulting to the global `document` -- an environment
 * with no `document`, such as this file's own node vitest tests, safely counts as "unavailable"),
 * which tests use to feed in the fake document wrapped by testing/fakeModelContext.ts's
 * `FakeModelContext`, with no need for jsdom or any new dependency. */
export class DomWebMcpFacade implements WebMcpPort {
  readonly #doc: WebMcpDocument | undefined;

  constructor(doc: WebMcpDocument | undefined = typeof document !== "undefined" ? (document as WebMcpDocument) : undefined) {
    this.#doc = doc;
  }

  isAvailable(): boolean {
    return this.#doc?.modelContext != null;
  }

  registerTools(defs: readonly WebMcpToolDefinition[]): WebMcpRegistration {
    const modelContext = this.#doc?.modelContext;
    if (!modelContext) return NOOP_REGISTRATION;

    const controller = new AbortController();

    // The genuine failures accumulated so far for this batch -- decided the instant each
    // attempt's rejection arrives, recorded and rolled back immediately the moment a genuine
    // failure is found (see recordRealFailure below), never waiting for the other attempts to
    // also settle (the review's follow-up fix, see the file header).
    const realFailures: { readonly name: string; readonly reason: unknown }[] = [];

    function recordRealFailure(name: string, reason: unknown): void {
      realFailures.push({ name, reason });
      // Rollback: every tool in the same batch shares the same controller/signal, so aborting
      // immediately deregisters the rest of this batch's already-mounted tools (whether already
      // resolved or still in flight), leaving no half-mounted intermediate state (see the
      // "Rollback rule" in the file header). If already aborted, this is a safe no-op.
      if (!controller.signal.aborted) controller.abort();
    }

    // Every registerTool() call immediately attaches .then(okResult, failResult) -- whether it
    // ultimately succeeds, fails, or rejects from an abort, none of it becomes an unhandled
    // rejection (the only change from the previous version is that failure information is no
    // longer simply discarded -- a genuine failure triggers recordRealFailure() right on the
    // spot). This attachment must happen synchronously with the registerTool() call (it can't
    // wait even one microtask), otherwise a rejection triggered by an abort could become an
    // unhandled rejection before anything catches it.
    const attempts: Promise<void>[] = defs.map((def) =>
      modelContext.registerTool(toModelContextTool(def), { signal: controller.signal }).then(
        () => undefined,
        (reason: unknown) => {
          // Being rejected as collateral from a call to abort() that we made ourselves doesn't
          // count as a genuine failure -- reason equals the reason from that abort() call of ours
          // (whether that abort was from dispose(), or was collateral rollback triggered by
          // "another" genuine failure's recordRealFailure() elsewhere in this batch). Anything
          // else is always a genuine failure of its own and must be recorded -- it can't be
          // misjudged as collateral just because "the signal happens to be aborted by now" (that
          // would miss recording an independent second genuine failure elsewhere in this batch,
          // see the file header).
          const isOwnAbort = controller.signal.aborted && reason === controller.signal.reason;
          if (!isOwnAbort) recordRealFailure(def.name, reason);
        },
      ),
    );

    // Internal bookkeeping -- guaranteed never to reject (see point 1 in the file header).
    // dispose() only ever awaits this one, so it can settle deterministically regardless of how
    // this batch ultimately turns out; `ready` also relies on it to make sure "every" attempt in
    // this batch has genuinely settled before reporting externally -- but the rollback itself
    // (cleaning up the map) was already done the instant recordRealFailure() ran above, not
    // deferred until here (see the file header).
    const allSettled = Promise.all(attempts).then(() => undefined);

    const ready: Promise<void> = allSettled.then(() => {
      if (realFailures.length === 0) {
        // Everything succeeded, or the only "failure" was the legitimate cancellation from our
        // own dispose -- ready keeps its existing (resolve) semantics, it doesn't pretend to
        // fail.
        return undefined;
      }
      throw new WebMcpRegistrationError(realFailures);
    });

    // A side handler: it's legitimate for a caller to "not await ready" (dispose only depends on
    // allSettled), but if ready's rejection has no handler at all, the runtime fires an
    // unhandledrejection -- attach an internal empty catch branch to mark it as handled; a caller
    // that does await ready still receives the original rejection as normal (caught during a
    // surprise mainline acceptance pass, regression test included).
    ready.catch(() => undefined);

    return {
      ready,
      async dispose() {
        controller.abort();
        await allSettled;
      },
    };
  }
}
