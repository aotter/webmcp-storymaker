// A test fake for document.modelContext — this is the foundation for the WebMCP tools
// tests. It's at a different layer than `FakeWebMcpFacade` in
// src/testing/fakes.ts: that fake is a simplified stand-in for `WebMcpPort` (this repo's own
// facade interface), while this one is a stand-in for the **native**
// `document.modelContext` (the W3C WebMCP spec's `ModelContext` interface) — it's used to test
// whether `../webmcp/facade.ts`'s `DomWebMcpFacade` correctly calls the spec-defined
// `registerTool(tool, { signal })`, not to test facade's own callers.
//
// Behavior is a subset checked against the spec (webmachinelearning/webmcp `index.bs`, the
// ModelContext/registerTool() algorithm):
//   - A name collision (a tool with the same name is already registering) always rejects, never
//     overwrites — spec: "If tool map[tool name] exists, then reject."
//   - Registration takes effect synchronously at call time (the tool is immediately visible to
//     getRegisteredTool()/invoke()), while the returned promise resolves on a separate
//     microtask — this gap is deliberately preserved so a test can call dispose() inside the
//     window where "registerTool() has been called but the promise hasn't resolved yet," and
//     verify that abort turns this not-yet-resolved promise into a rejection (spec: "add abort
//     steps: unregister + reject"), without needing a real timer — `queueMicrotask` alone is
//     enough to create this window, and `Promise.all`/`await` can deterministically wait for it
//     to settle.
//   - If signal is already aborted, registration is rejected immediately and never written into
//     the tool map (same spec section).
//   - If signal aborts later: the tool is removed from the tool map, and if the promise hasn't
//     resolved yet, it's turned into a rejection.
//
// The "not yet resolved" window created by
// `registerTool()`'s default `queueMicrotask` is only one microtask wide, which isn't enough to
// deterministically construct a race test for a batch like
// [good (not yet settled), bad (rejects immediately)] — because `good`'s (called first)
// `queueMicrotask` is scheduled earlier than `bad`'s (called after, rejects immediately) `.then()`
// reaction, so in practice `good` often resolves before `bad`'s failure is even processed, making
// it impossible to test the window where "bad's failure has arrived while good is still
// unsettled." `holdRegistration(name)`/`releaseRegistration(name)` let a test hand full manual
// control over the next `registerTool()` call's success-resolve for a given name to the test
// itself, independent of `queueMicrotask` timing — the tool is still written into the tool map
// synchronously per spec, and still gets the same abort listener (abort still removes it from
// the map immediately, and still rejects it if it hasn't resolved yet); only "when does it count
// as successful" is pulled out for the test to decide.
import type { ModelContextRegisterToolOptions, ModelContextTool, WebMcpDocument, WebMcpModelContext } from "../webmcp/types.ts";

interface RegisteredEntry {
  readonly tool: ModelContextTool;
  readonly signal: AbortSignal | undefined;
}

/** A record of one `FakeModelContext.registerTool()` call — the observation window a test uses
 * to assert "did facade correctly pass down the signal/annotations" — captures every
 * registerTool call, including the signal. */
export interface RecordedRegisterToolCall {
  readonly tool: ModelContextTool;
  readonly options: ModelContextRegisterToolOptions | undefined;
}

export class FakeModelContext implements WebMcpModelContext {
  /** A full record of every registerTool() call (including options, and therefore the signal) —
   * one entry is left behind whether it ultimately succeeds or fails; call order is array
   * order. */
  readonly calls: RecordedRegisterToolCall[] = [];
  readonly #tools = new Map<string, RegisteredEntry>();
  /** The set of names marked by `holdRegistration(name)` that haven't yet been consumed by the
   * next `registerTool()` call — see `holdRegistration()` below. */
  readonly #heldNames = new Set<string>();
  /** Currently "manually controlled, not yet resolved" registrations — name -> the resolve
   * function to trigger when `releaseRegistration(name)` is called. */
  readonly #manualReleases = new Map<string, () => void>();

  registerTool(tool: ModelContextTool, options?: ModelContextRegisterToolOptions): Promise<void> {
    this.calls.push({ tool, options });

    if (!tool.name || !tool.description) {
      return Promise.reject(new Error(`FakeModelContext: name/description must not be an empty string (name="${tool.name}")`));
    }
    if (this.#tools.has(tool.name)) {
      return Promise.reject(new Error(`FakeModelContext: a tool named "${tool.name}" is already registering, not overwriting`));
    }

    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("FakeModelContext: signal was already aborted at call time"));
    }

    // Spec behavior: the tool map write is synchronous — the tool is "attached" the moment
    // registerTool() is called, without waiting for the returned promise to resolve.
    this.#tools.set(tool.name, { tool, signal });

    const held = this.#heldNames.delete(tool.name);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // The spec's abort steps have two independent actions: "unregister the tool" always
      // happens (regardless of whether the registration promise has already resolved);
      // "reject promise" only makes sense while the promise hasn't settled yet (an
      // already-resolved promise can't be rejected again). A previous implementation
      // incorrectly gated both under the same `if (settled) return`, which meant abort had no
      // effect at all in the "await ready, then dispose()" scenario — fixed now: unregister
      // always runs, and only reject is guarded by settled.
      const onAbort = () => {
        this.#tools.delete(tool.name);
        this.#manualReleases.delete(tool.name);
        if (settled) return;
        settled = true;
        reject(signal!.reason ?? new Error("FakeModelContext: signal aborted"));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      const finishResolve = () => {
        if (settled) return;
        settled = true;
        // Don't remove the abort listener: the spec's unregister-on-abort binding lives as long
        // as the tool's registration, not as long as this promise — once a tool has
        // successfully registered and is "later" aborted, it still must be unregistered
        // (`{ once: true }` already guarantees this listener fires at most once, so it won't
        // unregister twice).
        resolve();
      };

      if (held) {
        // Manual control: don't auto-resolve, register it and wait for the test to call
        // releaseRegistration(name) — see the "added during review" note in this file's header.
        this.#manualReleases.set(tool.name, finishResolve);
      } else {
        // queueMicrotask creates the same timing gap as the spec (the map write is synchronous,
        // resolving the promise is a scheduled async task) — this gives a deterministic
        // "not yet resolved" window for testing abort races without needing a real timer.
        queueMicrotask(finishResolve);
      }
    });
  }

  /** Test-only: marks the **next** `registerTool()` call for this name as "manually delayed
   * settle" — the underlying promise won't auto-resolve via `queueMicrotask`; it stays pending
   * until the test calls `releaseRegistration(name)` (unless it's aborted in the meantime —
   * abort always still unregisters immediately as usual, and rejects it too if it hasn't
   * resolved yet, following exactly the same logic as the normal queueMicrotask path; only
   * "when it counts as successful" is pulled out for manual control). The mark is consumed only
   * once: a single `registerTool(name)` call clears it, so the same name needs
   * `holdRegistration()` called again for manual control next time. Used to precisely construct
   * race-condition test scenarios like "one tool in a batch hasn't settled yet while another has
   * genuinely failed," without gambling on queueMicrotask scheduling order. */
  holdRegistration(name: string): void {
    this.#heldNames.add(name);
  }

  /** Test-only: makes a `registerTool()` call that was previously held via `holdRegistration()`
   * and is still pending actually resolve. Safe no-op for a name that was never held, was
   * already released, or has already been aborted. */
  releaseRegistration(name: string): void {
    const release = this.#manualReleases.get(name);
    if (!release) return;
    this.#manualReleases.delete(name);
    release();
  }

  /** Test-only: the names of tools currently still "attached" (not removed via dispose/abort),
   * sorted — used when verifying "reload/unmount doesn't leave duplicate tools" to confirm the
   * count hasn't accumulated. */
  registeredNames(): string[] {
    return [...this.#tools.keys()].sort();
  }

  /** Test-only: reads back the full schema of an already-registered tool (name/description/
   * inputSchema/annotations) — lets the fake modelContext
   * actually retrieve the registered schema. Returns undefined if the tool doesn't exist
   * (never registered, or already removed). */
  getRegisteredTool(name: string): ModelContextTool | undefined {
    return this.#tools.get(name)?.tool;
  }

  /** Test-only: simulates an agent calling a registered tool's execute and getting the result
   * back. Throws if the tool doesn't exist (simulating an agent calling a tool name that isn't
   * registered / has been removed). When no signal is given, a default one that never aborts is
   * used; a caller that wants to test execute's internal abort handling can pass its own. */
  async invoke(name: string, input: unknown, signal: AbortSignal = new AbortController().signal): Promise<unknown> {
    const entry = this.#tools.get(name);
    if (!entry) throw new Error(`FakeModelContext: no registered tool named "${name}"`);
    return entry.tool.execute(input, { signal });
  }
}

/** Wraps a fake `Document` (with only the `modelContext` property) for `DomWebMcpFacade`'s
 * constructor to consume directly — `DomWebMcpFacade` only reads `doc.modelContext`, so it
 * doesn't need a real DOM/jsdom. */
export function createFakeWebMcpDocument(modelContext: WebMcpModelContext): WebMcpDocument {
  return { modelContext } as unknown as WebMcpDocument;
}
