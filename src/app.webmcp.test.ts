// Verifies the composition root (./app.ts) really does attach
// inspect_story/get_story_readiness/get_editor_focus to WebMCP, that `stop()` really unregisters
// them, and that repeated start()/stop() calls don't register duplicates; `registerTools()`'s
// `ready` rejection must be observable — must not block `start()` from completing, must be
// recorded onto App's observable state, must not be swallowed.
//
// Uses a real DomWebMcpFacade + FakeModelContext (not the simplified FakeWebMcpFacade from
// ./testing/fakes.ts — that one deliberately doesn't simulate name collisions and other edge
// cases, see that file's header), because only this combination can actually reproduce a
// scenario where `ready` genuinely rejects, rather than inventing a fake failure signal inside
// the test itself.
//
// Category: WebMCP lifecycle wiring, filename ends in .webmcp.test.ts, runs under test:webmcp
// (see README.md).
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { DomWebMcpFacade } from "./webmcp/facade.ts";
import { WebMcpRegistrationError } from "./webmcp/index.ts";
import type { WebMcpPort, WebMcpRegistration, WebMcpToolDefinition } from "./webmcp/index.ts";
import { createFakeWebMcpDocument, FakeModelContext } from "./testing/fakeModelContext.ts";
import { MemoryWorkspaceStorage } from "./testing/fakes.ts";

// app.start() combines the readonly tools and the write tools into
// one registerTools() call (see ./app.ts's header) — this constant covers every tool that's
// attached, not just the readonly ones. `registeredNames()` returns a sorted array.
const ALL_TOOL_NAMES = [
  "create_story",
  "get_editor_focus",
  "get_story_readiness",
  "inspect_story",
  "set_page_image",
  "update_page_text",
  "update_story_structure",
];

describe("createApp — WebMCP tools wiring (readonly + write tools registered as one batch)", () => {
  it("start() registers all seven tools (readonly + write) on the real modelContext; stop() unregisters all of them", async () => {
    const modelContext = new FakeModelContext();
    const webMcp = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const app = createApp({ storage: new MemoryWorkspaceStorage(), webMcp });

    await app.start();
    await app.webMcpToolsReady;

    expect(modelContext.registeredNames()).toEqual(ALL_TOOL_NAMES);
    expect(app.webMcpToolsError).toBeUndefined();

    await app.stop();

    expect(modelContext.registeredNames()).toEqual([]);
  });

  it("start()/stop()/start() again does not leave duplicate registrations", async () => {
    const modelContext = new FakeModelContext();
    const webMcp = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const app = createApp({ storage: new MemoryWorkspaceStorage(), webMcp });

    await app.start();
    await app.webMcpToolsReady;
    await app.stop();
    expect(modelContext.registeredNames()).toEqual([]);

    await app.start();
    await app.webMcpToolsReady;

    // After the second round of start(), the name list is still those same seven, not doubled
    // to fourteen — a reload/restart doesn't leave duplicate registrations (same spirit as
    // ../webmcp/facade.webmcp.test.ts's acceptance of facade itself's "re-attach without
    // duplicating"; here it's verifying the App layer's wiring correctly calls dispose).
    expect(modelContext.registeredNames()).toEqual(ALL_TOOL_NAMES);

    await app.stop();
    expect(modelContext.registeredNames()).toEqual([]);
  });

  it("does nothing when WebMCP is unavailable (no document.modelContext) — start() still completes cleanly", async () => {
    const webMcp = new DomWebMcpFacade(undefined);
    const app = createApp({ storage: new MemoryWorkspaceStorage(), webMcp });

    await app.start();

    expect(app.status).toBe("started");
    expect(app.webMcpAvailable).toBe(false);
    await expect(app.webMcpToolsReady).resolves.toBeUndefined();
    expect(app.webMcpToolsError).toBeUndefined();

    await app.stop();
  });

  it("observes a real registerTools() failure via webMcpToolsError without start() throwing or blocking", async () => {
    const modelContext = new FakeModelContext();
    // Pre-register a tool under the same name (occupying "inspect_story" and never releasing
    // it) — WebMcpPort.registerTools() guarantees a name collision always rejects, never
    // overwrites, so app.start()'s inspect_story in this batch is guaranteed to genuinely fail;
    // this isn't a fake failure fabricated by the test.
    await modelContext.registerTool({ name: "inspect_story", description: "placeholder", execute: async () => undefined });
    const webMcp = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const app = createApp({ storage: new MemoryWorkspaceStorage(), webMcp });

    await app.start();

    // start() itself must complete, not hang or throw outward just because a tool failed to
    // attach (doesn't block the fallback UI, see ./app.ts's header).
    expect(app.status).toBe("started");

    await expect(app.webMcpToolsReady).rejects.toBeInstanceOf(WebMcpRegistrationError);
    // After the rejection, the synchronously-readable webMcpToolsError must observe the same
    // error — a caller can find out "the last tool-attach attempt failed" without awaiting;
    // it's not a silently swallowed failure.
    expect(app.webMcpToolsError).toBeInstanceOf(WebMcpRegistrationError);
    expect(app.webMcpToolsError?.failures.map((f) => f.name)).toEqual(["inspect_story"]);

    // The rest of this batch — the tools that "would have" succeeded — get unregistered together
    // per the rollback rule (see ../webmcp/facade.ts's header) — only the placeholder tool the
    // test pre-registered remains on modelContext, no half-attached batch is left behind.
    expect(modelContext.registeredNames()).toEqual(["inspect_story"]);

    await app.stop();
  });
});

/** A manually controllable `WebMcpPort` fake — the test itself decides when and with what
 * outcome the `ready` returned by `registerTools()` settles; `dispose()` resolves immediately,
 * without waiting on `ready` at all (precisely reproducing the real timing gap in
 * `DomWebMcpFacade.dispose()` (../webmcp/facade.ts), which "only awaits allSettled, not ready" —
 * the real facade's gap is only one or two microtasks wide, hard to deterministically hit in a
 * test; this fake blows it up into "the test can hold it open for as long as it wants," not an
 * invented, fictional bug model). Used only in this file (the reproducible test for the
 * stale-rejection guard), not added to ../testing/fakes.ts — there's currently no second caller
 * that needs this level of manual precision. */
class ControllableWebMcpPort implements WebMcpPort {
  /** Indexed by the order `registerTools()` was called — each batch's own resolve/reject control
   * handle. */
  readonly batches: { resolveReady: () => void; rejectReady: (reason: unknown) => void }[] = [];

  isAvailable(): boolean {
    return true;
  }

  registerTools(_defs: readonly WebMcpToolDefinition[]): WebMcpRegistration {
    let resolveReady!: () => void;
    let rejectReady!: (reason: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.batches.push({ resolveReady, rejectReady });
    return { ready, dispose: async () => undefined };
  }
}

describe("createApp — start()/stop() re-entry guarantees (see ./app.ts's header)", () => {
  it("discards a stale ready-rejection from a superseded batch instead of polluting the current webMcpToolsError", async () => {
    const port = new ControllableWebMcpPort();
    const app = createApp({ storage: new MemoryWorkspaceStorage(), webMcp: port });

    // Sequence: start()₁ -> stop() (registration₁'s ready is deliberately still not
    // settled at this point, reproducing the window where the real facade's dispose() completes
    // but ready hasn't arrived yet) -> start()₂ (clean, its own second round succeeds on its
    // own).
    await app.start();
    await app.stop();
    await app.start();
    port.batches[1].resolveReady();
    await app.webMcpToolsReady;
    expect(app.webMcpToolsError).toBeUndefined();

    // registration₁ (the old, already-superseded round) only rejects now, due to its genuine
    // failure arriving late — this shouldn't be allowed to flip "the current" webMcpToolsError
    // from undefined to a value; this rejection is meaningless for the current state.
    port.batches[0].rejectReady(new Error("registration-1's genuine failure, arriving late"));
    // Let the .then() handler's microtask actually run (no timer needed, just queue a few
    // microtasks).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(app.webMcpToolsError).toBeUndefined();
  });

  it("calling start() twice without stop() in between does not leak the first registration", async () => {
    const modelContext = new FakeModelContext();
    const webMcp = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const app = createApp({ storage: new MemoryWorkspaceStorage(), webMcp });

    await app.start();
    await app.webMcpToolsReady;
    expect(modelContext.registeredNames()).toEqual(ALL_TOOL_NAMES);

    // Re-entry, no stop() call in between — the guard makes this an idempotent no-op:
    // registerTools() is not called again, the first round's registration stays the sole current
    // one, is never overwritten, and never leaks.
    await app.start();
    expect(modelContext.registeredNames()).toEqual(ALL_TOOL_NAMES);

    await app.stop();

    // Without the guard, the first round's registration would never be disposed (App's
    // #toolsRegistration field gets overwritten by the second round, the first round's reference
    // is lost forever) — after stop(), modelContext would still be left holding that first
    // round's three tools. With the guard, this must now be empty.
    expect(modelContext.registeredNames()).toEqual([]);
  });
});
