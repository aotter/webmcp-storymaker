// Acceptance:
//   (a) zero registration when there's no capability, isAvailable() reports false.
//   (b) with capability, registerTools() mounts everything, schema can be retrieved, execute can
//       be called.
//   (c) dispose() deregisters every tool, re-mounting doesn't duplicate (the reload/unmount
//       scenario).
//   (d) an abort mid-dispose() leaves no pending promise -- a decisive verification, no timers.
//
// Additional acceptance (see the "A same-name registration across batches must not be silently
// swallowed"/"Rollback rule" notes in the header of ./facade.ts):
//   (e) a same-name registration across batches -- the later batch's ready rejects (with the tool
//       name + reason), the earlier batch is completely unaffected, and the later batch's
//       otherwise-successful remaining tools are rolled back.
//   (f) a same-name collision within one batch -- ready rejects and the whole batch (including
//       ones that already succeeded) is rolled back, leaving no half-mounted batch.
//   (g) the control case where a dispose during registration doesn't count as a failure -- ready
//       still resolves, clearly distinguished from the genuine failures in (e)/(f).
//
// Category: WebMCP tool-surface logic, filenames ending in .webmcp.test.ts go into test:webmcp
// (see README.md).
import { describe, expect, it } from "vitest";
import { DomWebMcpFacade } from "./facade.ts";
import { WebMcpRegistrationError, type WebMcpToolDefinition } from "./types.ts";
import { createFakeWebMcpDocument, FakeModelContext } from "../testing/fakeModelContext.ts";

function tool(name: string, overrides: Partial<WebMcpToolDefinition> = {}): WebMcpToolDefinition {
  return {
    name,
    description: `Description of ${name}`,
    inputSchema: { type: "object", properties: {} },
    execute: async (input) => ({ echoed: input }),
    ...overrides,
  };
}

describe("DomWebMcpFacade — feature detection", () => {
  it("reports unavailable when there is no document (non-browser runtime)", () => {
    expect(typeof document).toBe("undefined");

    const facade = new DomWebMcpFacade();

    expect(facade.isAvailable()).toBe(false);
  });

  it("reports unavailable when the injected document has no modelContext", () => {
    const facade = new DomWebMcpFacade({} as never);

    expect(facade.isAvailable()).toBe(false);
  });

  it("reports available when the injected document exposes a modelContext", () => {
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(new FakeModelContext()));

    expect(facade.isAvailable()).toBe(true);
  });
});

describe("DomWebMcpFacade — registerTools() without capability", () => {
  it("registers nothing and dispose()/ready are both no-op-safe", async () => {
    const facade = new DomWebMcpFacade();

    const registration = facade.registerTools([tool("noop-tool")]);

    await expect(registration.ready).resolves.toBeUndefined();
    await expect(registration.dispose()).resolves.toBeUndefined();
  });
});

describe("DomWebMcpFacade — registerTools() with capability", () => {
  it("registers every tool on the fake modelContext — schema is retrievable", async () => {
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const schema = { type: "object", properties: { chapterSlug: { type: "string" } } };

    const registration = facade.registerTools([
      tool("tool-a", { inputSchema: schema, annotations: { readOnlyHint: true } }),
      tool("tool-b"),
    ]);
    await registration.ready;

    expect(modelContext.registeredNames()).toEqual(["tool-a", "tool-b"]);
    const registered = modelContext.getRegisteredTool("tool-a");
    expect(registered?.description).toBe("Description of tool-a");
    expect(registered?.inputSchema).toEqual(schema);
    expect(registered?.annotations).toEqual({ readOnlyHint: true });

    // Every registerTool() call carries the same AbortController's signal -- the facade strings
    // the whole batch of tools together internally on one signal, so dispose() can deregister all
    // of them at once.
    expect(modelContext.calls).toHaveLength(2);
    expect(modelContext.calls[0].options?.signal).toBeInstanceOf(AbortSignal);
    expect(modelContext.calls[0].options?.signal).toBe(modelContext.calls[1].options?.signal);
  });

  it("an agent can call a registered tool's execute through the fake modelContext and get back a result", async () => {
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));

    const registration = facade.registerTools([
      tool("echo", { execute: async (input) => ({ received: input }) }),
    ]);
    await registration.ready;

    const result = await modelContext.invoke("echo", { chapterSlug: "ch1" });

    expect(result).toEqual({ received: { chapterSlug: "ch1" } });
  });

  it("dispose() deregisters every tool — registeredNames() drops to zero", async () => {
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));

    const registration = facade.registerTools([tool("tool-a"), tool("tool-b")]);
    await registration.ready;
    expect(modelContext.registeredNames()).toEqual(["tool-a", "tool-b"]);

    await registration.dispose();

    expect(modelContext.registeredNames()).toEqual([]);
  });

  it("dispose() is idempotent — calling it repeatedly does not throw and does not abort twice", async () => {
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));

    const registration = facade.registerTools([tool("tool-a")]);
    await registration.ready;

    await registration.dispose();
    await expect(registration.dispose()).resolves.toBeUndefined();
  });

  it("the reload/unmount scenario: re-registering the same tool names after dispose() causes no conflict and leaves no duplicates", async () => {
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));

    const first = facade.registerTools([tool("tool-a"), tool("tool-b")]);
    await first.ready;
    expect(modelContext.registeredNames()).toEqual(["tool-a", "tool-b"]);

    await first.dispose();
    expect(modelContext.registeredNames()).toEqual([]);

    const second = facade.registerTools([tool("tool-a"), tool("tool-b")]);
    await second.ready;

    // Re-mounting succeeds (not rejected by the fake modelContext for "the name already exists"),
    // and it doesn't accumulate to 4 entries.
    expect(modelContext.registeredNames()).toEqual(["tool-a", "tool-b"]);
    expect(modelContext.calls).toHaveLength(4);
  });

  it("an abort mid-dispose() leaves no pending promise — a decisive verification, no timers", async () => {
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));

    const registration = facade.registerTools([tool("tool-a")]);
    // Deliberately not awaiting registration.ready -- FakeModelContext only resolves the
    // underlying registerTool() promise via queueMicrotask, so at this point it's guaranteed to
    // still be pending. The tool is already mounted synchronously (per spec: the tool map write
    // is synchronous, only the promise resolution is the queued asynchronous task).
    expect(modelContext.registeredNames()).toEqual(["tool-a"]);

    // Call dispose() before the underlying registration completes: the abort signal ->
    // FakeModelContext's abort listener turns this not-yet-resolved registerTool() promise into a
    // rejection and removes the tool from the map; the facade's internal `.then(ok, ok)` already
    // caught this rejection in the same tick as the registerTools() call, so `dispose()`'s
    // internal `await` of `ready` is guaranteed to settle -- no timer involved, purely
    // deterministic behavior that relies on microtask ordering.
    await registration.dispose();

    expect(modelContext.registeredNames()).toEqual([]);
    // ready itself is also guaranteed to have settled, without throwing -- after dispose() there
    // is no leftover pending/unhandled promise.
    await expect(registration.ready).resolves.toBeUndefined();
  });

  it("two tools with the same name inside one registerTools() call — ready rejects (with the tool name), the whole batch (including the one that already succeeded) is rolled back", async () => {
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));

    const registration = facade.registerTools([tool("dup"), tool("dup")]);

    const error = await registration.ready.then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(WebMcpRegistrationError);
    expect((error as WebMcpRegistrationError).failures.map((f) => f.name)).toEqual(["dup"]);

    // The first "dup" originally mounted successfully, but because this batch has a genuine
    // failure (the second one colliding on the same name), the whole batch (including the one
    // that already succeeded) is deregistered together -- leaving no half-mounted intermediate
    // state (see the "Rollback rule" note in the header of ./facade.ts).
    expect(modelContext.registeredNames()).toEqual([]);

    // Still clean after dispose -- even though this batch never genuinely "succeeded," dispose()
    // neither hangs nor throws.
    await expect(registration.dispose()).resolves.toBeUndefined();
  });

  it("a same-name registration across batches — the later batch's ready rejects, the earlier batch is completely unaffected, and the later batch's other successful tool is rolled back", async () => {
    // The sequence that reproduces the bug: batch1 mounts a tool (the caller
    // forgot to/hasn't yet disposed it) -> batch2 registers a tool with the same name (plus a
    // non-conflicting tool) together. Before the fix: the spec's name-collision rejection was
    // silently flattened by the facade's .then(ok, ok), batch2.ready falsely resolved as if it
    // succeeded, and when the agent later called this tool name, it was actually still served by
    // batch1's stale closure.
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));

    const batch1Calls: unknown[] = [];
    const batch1 = facade.registerTools([
      tool("story.write", {
        execute: async (input) => {
          batch1Calls.push(input);
          return { from: "batch1" };
        },
      }),
    ]);
    await batch1.ready;
    expect(modelContext.registeredNames()).toEqual(["story.write"]);

    const batch2 = facade.registerTools([
      tool("story.write", { execute: async () => ({ from: "batch2" }) }),
      tool("story.read"),
    ]);

    const error = await batch2.ready.then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(WebMcpRegistrationError);
    expect((error as WebMcpRegistrationError).failures.map((f) => f.name)).toEqual(["story.write"]);

    // batch1 is completely unaffected -- the "story.write" on modelContext is still the one
    // batch1 mounted; calling it still uses batch1's closure, not batch2's version, which was
    // never actually mounted.
    expect(modelContext.registeredNames()).toEqual(["story.write"]);
    const result = await modelContext.invoke("story.write", { foo: "bar" });
    expect(result).toEqual({ from: "batch1" });
    expect(batch1Calls).toEqual([{ foo: "bar" }]);

    // batch2's story.read, which had "originally succeeded," is rolled back -- no half-mounted
    // intermediate state is left behind.
    expect(modelContext.getRegisteredTool("story.read")).toBeUndefined();

    // Both batches' dispose calls are clean -- neither hangs nor throws.
    await expect(batch1.dispose()).resolves.toBeUndefined();
    await expect(batch2.dispose()).resolves.toBeUndefined();
    expect(modelContext.registeredNames()).toEqual([]);
  });

  it("control case: a dispose during registration doesn't count as a failure — ready still resolves, clearly distinguished from a genuine failure", async () => {
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));

    const registration = facade.registerTools([tool("tool-a")]);
    // Deliberately not awaiting ready, disposing immediately -- the underlying registerTool()
    // promise is guaranteed to still be pending at this point (FakeModelContext only resolves it
    // via queueMicrotask); the abort makes it reject, but this rejection's reason is exactly the
    // reason from our own abort() call this time -- not a "genuine registration failure," so ready
    // keeps its existing (resolve) semantics, clearly different from the two genuine-failure cases
    // above (where ready rejects).
    await registration.dispose();

    await expect(registration.ready).resolves.toBeUndefined();
    expect(modelContext.registeredNames()).toEqual([]);
  });
});

describe("no half-mounted-batch window is left open", () => {
  it("[good(manually delayed settle), bad(rejects immediately)] — good is already removed from the map before it even settles; settling afterward doesn't affect the rollback outcome", async () => {
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    // "good"'s next registerTool() call is manually controlled -- instead of gambling on
    // queueMicrotask scheduling that "bad's failure will always be observed before good's
    // success," it deterministically holds good in the window of "already synchronously written
    // into the tool map, but the underlying promise hasn't settled yet" until the test explicitly
    // releases it.
    modelContext.holdRegistration("good");
    // "bad" uses an empty description to trigger FakeModelContext's synchronous (immediate)
    // rejection -- this doesn't depend on any cross-batch state, reproducing "another already-known
    // genuine failure" within a single batch.
    const registration = facade.registerTools([tool("good"), tool("bad", { description: "" })]);

    // Only one microtask tick is needed: bad's promise is already in a rejected state at the
    // moment registerTool() is called, so the facade's attached .then(fail) reaction is queued
    // into the first round of microtasks, and running it synchronously triggers
    // controller.abort().
    await Promise.resolve();

    // The key assertion: good hasn't settled at all yet here (releaseRegistration("good") hasn't
    // been called), but because bad's genuine failure already triggered the rollback in that
    // microtask above, good has already been removed from the tool map by the abort -- the agent
    // can't see it or call it; it isn't cleaned up only once the whole batch "fully" settles.
    expect(modelContext.registeredNames()).toEqual([]);
    expect(modelContext.getRegisteredTool("good")).toBeUndefined();

    // Only afterward does good actually settle (it was in fact already forcibly settled via the
    // abort's rejection path; calling this verifies that "releasing it again after the fact" is a
    // safe no-op that doesn't throw and doesn't hang ready or dispose).
    modelContext.releaseRegistration("good");

    const error = await registration.ready.then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(WebMcpRegistrationError);
    // Only bad is a genuine failure -- good's rejection reason is our own abort, correctly
    // excluded from WebMcpRegistrationError.
    expect((error as WebMcpRegistrationError).failures.map((f) => f.name)).toEqual(["bad"]);

    // The whole dispose path is still clean -- no pending, no unhandled.
    await expect(registration.dispose()).resolves.toBeUndefined();
  });

  it("control case: when every tool in a batch is manually delayed and settles, and none genuinely fails, it isn't misjudged as needing a rollback", async () => {
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    modelContext.holdRegistration("a");
    modelContext.holdRegistration("b");

    const registration = facade.registerTools([tool("a"), tool("b")]);

    // Wait a few more rounds of microtasks to confirm that "simply hasn't settled yet" by itself
    // is never misjudged as a genuine failure that triggers an abort.
    await Promise.resolve();
    await Promise.resolve();
    expect(modelContext.registeredNames()).toEqual(["a", "b"]);

    modelContext.releaseRegistration("a");
    modelContext.releaseRegistration("b");

    await expect(registration.ready).resolves.toBeUndefined();
    expect(modelContext.registeredNames()).toEqual(["a", "b"]);

    await expect(registration.dispose()).resolves.toBeUndefined();
    expect(modelContext.registeredNames()).toEqual([]);
  });
});

describe("unhandledrejection protection when ready is ignored (found during mainline acceptance)", () => {
  it("when the caller doesn't await ready, a genuine registration failure must not become an unhandledrejection; a caller that does await it still receives the rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const modelContext = new FakeModelContext();
      const facade = new DomWebMcpFacade({ modelContext } as unknown as Document);
      const def = (name: string): WebMcpToolDefinition => ({
        name, description: "A test tool", execute: async () => "ok",
      });
      const batch1 = facade.registerTools([def("dup")]);
      await batch1.ready;

      // The caller "ignores ready" -- the same-name collision is a genuine failure, but it must
      // not blow up into an unhandledrejection.
      const batch2 = facade.registerTools([def("dup")]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);

      // A caller that does await it still receives the original rejection as normal (the side
      // handler doesn't change the external semantics).
      await expect(batch2.ready).rejects.toBeInstanceOf(WebMcpRegistrationError);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("real-browser regression: the host calls execute without options/signal", () => {
  // The ChatGPT desktop app's built-in browser (tested 2026-09) calls a registered tool's execute
  // without passing a second argument -- passing that straight through to def.execute would make
  // the tool's very first line, reading `signal.aborted`, reject with a native TypeError,
  // bypassing the safe DTO (the observed error: `Cannot read properties of undefined
  // (reading 'aborted')`). Fix: toModelContextTool() normalizes it at the boundary -- whatever
  // shape the host gives, the internal tool always gets a real AbortSignal.
  it("the mounted native tool, when called as execute(input) and execute(input, {}), still gets an internal, unaborted AbortSignal", async () => {
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const seenSignals: unknown[] = [];
    const registration = facade.registerTools([
      tool("host-shape-probe", {
        execute: async (input, options) => {
          seenSignals.push(options.signal);
          if (options.signal.aborted) throw new Error("should never reach here: the fallback signal must not be aborted");
          return { echoed: input };
        },
      }),
    ]);
    await registration.ready;

    const native = modelContext.getRegisteredTool("host-shape-probe");
    expect(native).toBeDefined();

    // Real-host shape 1: no options at all.
    await expect(native!.execute({ probe: 1 })).resolves.toEqual({ echoed: { probe: 1 } });
    // Real-host shape 2: an empty options object, no signal.
    await expect(native!.execute({ probe: 2 }, {})).resolves.toEqual({ echoed: { probe: 2 } });
    // The spec shape: when the host genuinely passes a signal, it must pass through unchanged (it
    // must not be overwritten by the fallback signal).
    const hostController = new AbortController();
    await expect(native!.execute({ probe: 3 }, { signal: hostController.signal })).resolves.toEqual({
      echoed: { probe: 3 },
    });

    expect(seenSignals).toHaveLength(3);
    for (const s of seenSignals) expect(s).toBeInstanceOf(AbortSignal);
    expect(seenSignals[2]).toBe(hostController.signal);

    await registration.dispose();
  });

  it("when the host passes an already-aborted signal, it still passes through unchanged — the tool rejects with the abort reason per its existing convention", async () => {
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const registration = facade.registerTools([
      tool("abort-passthrough-probe", {
        execute: async (_input, options) => {
          if (options.signal.aborted) throw options.signal.reason ?? new Error("aborted");
          return { ok: true };
        },
      }),
    ]);
    await registration.ready;

    const native = modelContext.getRegisteredTool("abort-passthrough-probe");
    const controller = new AbortController();
    const reason = new Error("the host cancelled it");
    controller.abort(reason);

    await expect(native!.execute({}, { signal: controller.signal })).rejects.toBe(reason);

    await registration.dispose();
  });
});
