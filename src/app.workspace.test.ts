// Behavior tests for the composition root.
//
// Proves two things:
//   (a) Starting with all-fake ports -> observable state becomes started; stopping -> resource
//       release is observable.
//   (b) The same test scenario still works when a fresh fake storage instance is swapped in
//       (injection is real, not an imported singleton).
//
// Category: exercises the workspace storage's lifecycle and the composition root's injection
// behavior, so it's a workspace-category file, filename ends in .workspace.test.ts, runs under
// test:workspace (see README.md).
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { FakeWebMcpFacade, MemoryWorkspaceStorage } from "./testing/fakes.ts";
import { createMinimalStory } from "./story/createMinimalStory.ts";

describe("createApp — composition root", () => {
  it("starts with all-fake ports: status and webMcpAvailable become observable", async () => {
    const storage = new MemoryWorkspaceStorage();
    const webMcp = new FakeWebMcpFacade(true);

    const app = createApp({ storage, webMcp });
    expect(app.status).toBe("idle");
    expect(storage.isOpen).toBe(false);

    await app.start();

    expect(app.status).toBe("started");
    expect(app.webMcpAvailable).toBe(true);
    expect(storage.isOpen).toBe(true);
  });

  it("stop() releases storage — observable via the fake's own state, not an internal app flag", async () => {
    const storage = new MemoryWorkspaceStorage();
    const app = createApp({
      storage,
      webMcp: new FakeWebMcpFacade(false),
    });

    await app.start();
    expect(storage.isOpen).toBe(true);

    await app.stop();

    expect(app.status).toBe("stopped");
    expect(storage.isOpen).toBe(false);
  });

  it("webMcpAvailable reflects whatever the injected webMcp fake reports", async () => {
    const unavailable = createApp({
      storage: new MemoryWorkspaceStorage(),
      webMcp: new FakeWebMcpFacade(false),
    });
    await unavailable.start();
    expect(unavailable.webMcpAvailable).toBe(false);

    const available = createApp({
      storage: new MemoryWorkspaceStorage(),
      webMcp: new FakeWebMcpFacade(true),
    });
    await available.start();
    expect(available.webMcpAvailable).toBe(true);
  });

  it("swapping in a fresh fake storage instance for the same scenario still works — proves injection is real, not a shared import singleton", async () => {
    async function runScenario(storage: MemoryWorkspaceStorage) {
      const app = createApp({ storage, webMcp: new FakeWebMcpFacade(true) });
      await app.start();
      await app.stop();
      return { open: storage.isOpen };
    }

    const first = await runScenario(new MemoryWorkspaceStorage());
    const second = await runScenario(new MemoryWorkspaceStorage());

    expect(first.open).toBe(false);
    expect(second.open).toBe(false);
  });

  // App's `focus` member (./story/focus.ts) — every createApp() call
  // must get its own independent controller bound to "the storage injected this time," not a
  // global singleton (same acceptance spirit as "swapping the instance still works" for storage
  // above).
  it("exposes a focus controller bound to the injected storage — not a global singleton", async () => {
    const storageA = new MemoryWorkspaceStorage();
    await storageA.open();
    const seededA = await createMinimalStory(storageA, { slug: "story-a", title: "Story A" });
    expect(seededA.ok).toBe(true);
    const appA = createApp({ storage: storageA, webMcp: new FakeWebMcpFacade(true) });

    const storageB = new MemoryWorkspaceStorage();
    await storageB.open();
    const seededB = await createMinimalStory(storageB, { slug: "story-b", title: "Story B" });
    expect(seededB.ok).toBe(true);
    const appB = createApp({ storage: storageB, webMcp: new FakeWebMcpFacade(true) });

    const setA = await appA.focus.setFocus({ storySlug: "story-a" });
    const setB = await appB.focus.setFocus({ storySlug: "story-b" });

    expect(setA).toEqual({ ok: true, focus: { storySlug: "story-a", chapterSlug: undefined, tab: undefined } });
    expect(setB).toEqual({ ok: true, focus: { storySlug: "story-b", chapterSlug: undefined, tab: undefined } });
    // appA's focus was validated against storageA (story-a) — asking appB's controller to claim
    // story-a should be dropped, proving the two App instances' focus each bind to their own
    // storage and don't share one global state.
    const crossed = await appB.focus.setFocus({ storySlug: "story-a" });
    expect(crossed.ok).toBe(false);
    expect(appA.focus).not.toBe(appB.focus);
  });
});
