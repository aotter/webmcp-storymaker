// State-transition tests for
// StoryUiController (./controller.ts) -- see the header note in ./controller.ts: the
// controller never writes to the workspace itself, and every write happens through WebMCP
// tools (../webmcp/tools/writeTools.ts, see the cross-layer integration test
// ../webmcp/tools/writeTools.webmcp.test.ts). This file only tests the drastically simplified
// interface hydrate()/openMapNode()/closeMapNode()/setActiveTab()/previewFromNode()/
// consumePreviewStartPageId()/readAcceptedMedia(), none of it through the DOM (the controller only
// touches WorkspaceStoragePort + FocusController, with zero browser API access), pure data-layer
// assertions, needing no jsdom.
//
// Classification: exercises the combined behavior of workspace storage and the story layer, so the
// filename ends in .workspace.test.ts to run under test:workspace (see README.md).
import { describe, expect, it } from "vitest";
import { MemoryWorkspaceStorage } from "../testing/fakes.ts";
import { GateableStorage } from "../testing/gateableStorage.ts";
import { createFocusController, createMinimalStory, updatePageText, updateStoryStructure, type FocusController } from "../story/index.ts";
import type { WorkspaceStoragePort } from "../ports.ts";
import { createStoryUiController, type StoryUiController } from "./controller.ts";
import type { EditorState } from "./state.ts";
import type { HostSessionDeps, HostSessionLike, HostSessionState } from "../preview/hostSession.ts";

const initialFakeSessionState: HostSessionState = { phase: "connecting", pairingCode: null, viewerUrl: null, errorMessage: null };

/** Testing "switching tabs doesn't end the session, only ending the
 * preview closes it" doesn't need a real WebSocket -- this fake implements the `HostSessionLike`
 * exported by ../preview/hostSession.ts, and the test itself decides what phase each of
 * `start()`/`approve()`/`reject()`/`end()` transitions to, recording how many times each method was
 * called for assertions. Like the real HostSession, it notifies the controller via
 * `deps.onStateChange`. */
class FakeHostSession implements HostSessionLike {
  #state: HostSessionState = initialFakeSessionState;
  startCalls = 0;
  approveCalls = 0;
  rejectCalls = 0;
  endCalls = 0;

  constructor(private readonly deps: HostSessionDeps) {}

  getState(): HostSessionState {
    return this.#state;
  }

  async start(viewerOrigin: string): Promise<void> {
    this.startCalls++;
    // Deliberately zero await -- goes into setState synchronously, so the caller (the controller)
    // doesn't need to await this Promise to see the state already updated, in the same spirit as
    // the real HostSession not blocking on any asynchronous boundary before sending hello (this fake
    // doesn't even have the asynchronous boundary of opening a WebSocket -- it's a plain fake).
    this.#setState({ ...this.#state, phase: "waiting-for-scan", pairingCode: "1234", viewerUrl: `${viewerOrigin}/preview.html#t=fake` });
  }

  approve(): void {
    this.approveCalls++;
    if (this.#state.phase !== "confirm-pairing") return;
    this.#setState({ ...this.#state, phase: "transferring" });
  }

  reject(): void {
    this.rejectCalls++;
    if (this.#state.phase !== "confirm-pairing") return;
    this.#setState({ ...this.#state, phase: "waiting-for-scan" });
  }

  end(): void {
    this.endCalls++;
    this.#setState({ ...this.#state, phase: "ended" });
  }

  /** Test-only -- simulates the phone side sending a pairing request (not part of the
   * HostSessionLike interface). */
  simulatePairRequest(): void {
    if (this.#state.phase !== "waiting-for-scan") return;
    this.#setState({ ...this.#state, phase: "confirm-pairing" });
  }

  #setState(next: HostSessionState): void {
    this.#state = next;
    this.deps.onStateChange(next);
  }
}

interface ControllerTestOptions {
  readonly relayUrl?: string;
  readonly createHostSession?: (deps: HostSessionDeps) => HostSessionLike;
}

function makeController(options: ControllerTestOptions = {}): { storage: MemoryWorkspaceStorage; focus: FocusController; controller: StoryUiController } {
  const storage = new MemoryWorkspaceStorage();
  const focus = createFocusController(storage);
  const controller = createStoryUiController({
    storage,
    focus,
    viewerOrigin: "https://example.test",
    relayUrl: options.relayUrl,
    createHostSession: options.createHostSession,
  });
  return { storage, focus, controller };
}

function makeGateableController(): { storage: GateableStorage; focus: FocusController; controller: StoryUiController } {
  const storage = new GateableStorage(new MemoryWorkspaceStorage());
  const focus = createFocusController(storage);
  const controller = createStoryUiController({ storage, focus, viewerOrigin: "https://example.test", relayUrl: undefined });
  return { storage, focus, controller };
}

/** Builds a controller wired up with a factory function that captures
 * the most recently built FakeHostSession -- most tests only care whether "this operation touched
 * the current session", without needing to hand-assemble HostSessionDeps themselves. */
function makeControllerWithFakeSession(): { storage: MemoryWorkspaceStorage; controller: StoryUiController; sessions: FakeHostSession[] } {
  const sessions: FakeHostSession[] = [];
  const { storage, controller } = makeController({
    relayUrl: "wss://relay.test",
    createHostSession: (deps) => {
      const session = new FakeHostSession(deps);
      sessions.push(session);
      return session;
    },
  });
  return { storage, controller, sessions };
}

/** Uses a macrotask (setTimeout 0ms) to flush every microtask currently queued -- an existing
 * guarantee of the JS event loop: a macrotask always runs after all currently queued microtasks,
 * not a "guess the timing" use of a timer (same existing precedent as the old test files). */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function seedMinimalStory(storage: WorkspaceStoragePort, slug = "demo", title = "Sample Story"): Promise<{ revision: number }> {
  await storage.open();
  const created = await createMinimalStory(storage, { slug, title });
  if (!created.ok) throw new Error("seed failed: " + JSON.stringify(created.error));
  return { revision: created.revision };
}

/** Adds a second page (page-02) with no text yet, for tests of "a missing pagePreviews entry means
 * no text" / a multi-node map. */
async function addSecondPage(storage: WorkspaceStoragePort, expectedRevision: number): Promise<{ revision: number }> {
  const current = await updateStoryStructure(storage, {
    expectedRevision,
    spec: {
      specVersion: "storymaker/v1alpha1",
      kind: "Story",
      metadata: { slug: "demo" },
      start: "page-01",
      nodes: {
        "page-01": { content: { $ref: "content://demo/chapters/page-01#fragments/text" }, next: "page-02" },
        "page-02": { content: { $ref: "content://demo/chapters/page-02#fragments/text" }, type: "ending", ending: { endingId: "page-02", endingType: "good" } },
      },
    },
  });
  if (!current.ok) throw new Error("failed to add page: " + JSON.stringify(current.error));
  return { revision: current.revision };
}

function asEditor(controller: StoryUiController): EditorState {
  const state = controller.getState();
  if (state.view !== "editor") throw new Error(`expected editor view, got ${state.view}`);
  return state;
}

async function writeImage(storage: WorkspaceStoragePort, expectedRevision: number, chapterSlug: string): Promise<{ revision: number }> {
  const result = await storage.mutate({
    expectedRevision,
    ops: [
      { op: "write", path: `media/${chapterSlug}.png`, kind: "blob", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]) },
      { op: "write", path: "media.json", kind: "text", text: JSON.stringify({ [chapterSlug]: { file: `${chapterSlug}.png` } }) },
    ],
  });
  if (!result.ok) throw new Error("failed to write image: " + JSON.stringify(result.error));
  return { revision: result.revision };
}

describe("StoryUiController — hydrate(): the view state machine", () => {
  it("deleteStory() empties the workspace and returns to the create view", async () => {
    const { storage, controller } = makeController();
    await storage.open();
    await createMinimalStory(storage, { slug: "pig", title: "Pig" });
    await controller.hydrate();
    expect(controller.getState().view).toBe("editor");

    await controller.deleteStory();

    expect((await storage.list()).entries).toHaveLength(0);
    expect(controller.getState().view).toBe("create");
  });

  it("shows the empty (create) view — with no fields — when the workspace has no story", async () => {
    const { storage, controller } = makeController();
    await storage.open();

    await controller.hydrate();

    expect(controller.getState()).toEqual({ view: "create" });
  });

  it("shows the error view with an English message when story.yaml is malformed", async () => {
    const storage = new MemoryWorkspaceStorage();
    await storage.open();
    const written = await storage.mutate({ expectedRevision: 0, ops: [{ op: "write", path: "story.yaml", kind: "text", text: "not: valid: yaml: [" }] });
    expect(written.ok).toBe(true);
    const focus = createFocusController(storage);
    const controller = createStoryUiController({ storage, focus, viewerOrigin: "https://example.test", relayUrl: undefined });

    await controller.hydrate();

    const state = controller.getState();
    expect(state.view).toBe("error");
    if (state.view !== "error") return;
    expect(state.message).toContain("The story file is corrupted");
  });

  it("populates the editor view with spec/title/revision/mediaSlugs/pagePreviews for a two-page story", async () => {
    const { storage, controller } = makeController();
    const seeded = await seedMinimalStory(storage, "demo", "Sample Story");
    const withSecondPage = await addSecondPage(storage, seeded.revision);
    const wroteText = await updatePageText(storage, { expectedRevision: withSecondPage.revision, chapterSlug: "page-01", lang: "en", text: "The first page\u2019s text." });
    if (!wroteText.ok) throw new Error("write failed");
    const withImage = await writeImage(storage, wroteText.revision, "page-01");

    await controller.hydrate();

    const state = asEditor(controller);
    expect(state.storySlug).toBe("demo");
    expect(state.title).toBe("Sample Story");
    expect(state.revision).toBe(withImage.revision);
    expect(Object.keys(state.spec.nodes).sort()).toEqual(["page-01", "page-02"]);
    expect(state.mediaSlugs.has("page-01")).toBe(true);
    expect(state.mediaSlugs.has("page-02")).toBe(false);
    expect(state.pagePreviews.get("page-01")).toBe("The first page\u2019s text.");
    expect(state.pagePreviews.has("page-02")).toBe(false); // This page has no text yet -- missing, not an empty string
    expect(state.mapSelection).toBeNull();
    expect(state.activeTab).toBe("map");
    expect(state.previewStartPageId).toBeNull();
    // readiness starts out loading -- the caller (../map/render.ts) doesn't assume a result is
    // already available the moment hydrate() returns.
    await flushMicrotasks();
    const afterReadiness = asEditor(controller);
    expect(afterReadiness.readinessLoading).toBe(false);
    expect(afterReadiness.readiness).not.toBeNull();
  });

  it("re-hydrating (refresh button, or agent write via onWorkspaceMutated) preserves activeTab and mapSelection", async () => {
    const { storage, controller } = makeController();
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();

    controller.setActiveTab("preview");
    controller.openMapNode("page-01");
    expect(asEditor(controller).activeTab).toBe("preview");
    expect(asEditor(controller).mapSelection).toBe("page-01");

    await controller.hydrate();

    const state = asEditor(controller);
    expect(state.activeTab).toBe("preview");
    expect(state.mapSelection).toBe("page-01");
  });

  it("a fresh mount (loading → create/error/editor) always starts on the map tab with no selection", async () => {
    const { storage, controller } = makeController();
    await seedMinimalStory(storage, "demo", "Sample Story");

    await controller.hydrate();

    const state = asEditor(controller);
    expect(state.activeTab).toBe("map");
    expect(state.mapSelection).toBeNull();
  });

  it("a stale hydrate() call that resumes after a newer one has already finished makes zero further state writes", async () => {
    const { storage, controller } = makeGateableController();
    await seedMinimalStory(storage, "demo", "First Title");
    await controller.hydrate();

    // A gets stuck right before readStory()'s first internal readFile("story.yaml") call -- see
    // the header of ../testing/gateableStorage.ts: the gate only intercepts "the next readFile call
    // after this one is called"; list() is unaffected.
    const release = storage.gateNextCall("readFile");
    const hydrateA = controller.hydrate();
    await flushMicrotasks(); // Confirms A is genuinely stuck on the gate, not just not yet started

    // While A is stuck, meta.json is changed directly (bypassing the controller), and then a
    // whole separate hydrate() call (B) is allowed to run to completion.
    const snapshot = await storage.list();
    const written = await storage.mutate({ expectedRevision: snapshot.revision, ops: [{ op: "write", path: "meta.json", kind: "text", text: '{"title":"Second Title"}' }] });
    expect(written.ok).toBe(true);
    await controller.hydrate(); // B -- runs to completion, reads "Second Title"
    const afterB = controller.getState();
    expect(asEditor(controller).title).toBe("Second Title");

    // Release A -- A resumes execution, but by now #hydrateGen has already been advanced by B, so
    // A should give up entirely at the first generation check after readStory() returns, never
    // calling #setState() again. Proven by reference equality (not content equality): if A really
    // had called #setState() (even if it happened to write out identical content), the object
    // reference returned by getState() would have changed too.
    release();
    await hydrateA;
    expect(controller.getState()).toBe(afterB);
  });
});

describe("StoryUiController — openMapNode()/closeMapNode(): purely synchronous node selection", () => {
  it("selects/deselects a node synchronously — no pending async load, content is already in pagePreviews", async () => {
    const { storage, controller } = makeController();
    const seeded = await seedMinimalStory(storage, "demo", "Sample Story");
    await updatePageText(storage, { expectedRevision: seeded.revision, chapterSlug: "page-01", lang: "en", text: "Text that\u2019s already written." });
    await controller.hydrate();

    controller.openMapNode("page-01");
    // Readable immediately after the synchronous call -- no need to await anything.
    expect(asEditor(controller).mapSelection).toBe("page-01");
    expect(asEditor(controller).pagePreviews.get("page-01")).toBe("Text that\u2019s already written.");

    controller.closeMapNode();
    expect(asEditor(controller).mapSelection).toBeNull();
  });

  it("openMapNode() claims editor focus (get_editor_focus) for the selected chapterSlug", async () => {
    const { storage, focus, controller } = makeController();
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();

    controller.openMapNode("page-01");
    await flushMicrotasks(); // openMapNode()\u2019s focus.setFocus() is fire-and-forget

    const claimed = await focus.getFocus();
    expect(claimed).toEqual({ storySlug: "demo", chapterSlug: "page-01", tab: "content" });
  });

  it("is a no-op outside the editor view", () => {
    const { controller } = makeController();
    expect(controller.getState().view).toBe("loading");
    controller.openMapNode("page-01"); // Not throwing is a pass -- there\u2019s no node to select in the loading view
    expect(controller.getState().view).toBe("loading");
  });
});

describe("StoryUiController — setActiveTab() / previewFromNode() / consumePreviewStartPageId()", () => {
  it("switches between map and preview tabs", async () => {
    const { storage, controller } = makeController();
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();

    controller.setActiveTab("preview");
    expect(asEditor(controller).activeTab).toBe("preview");
    controller.setActiveTab("map");
    expect(asEditor(controller).activeTab).toBe("map");
  });

  it("previewFromNode() switches to the preview tab and stages a start page id; consuming it clears it", async () => {
    const { storage, controller } = makeController();
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();

    controller.previewFromNode("page-01");
    expect(asEditor(controller).activeTab).toBe("preview");
    expect(asEditor(controller).previewStartPageId).toBe("page-01");

    expect(controller.consumePreviewStartPageId()).toBe("page-01");
    expect(asEditor(controller).previewStartPageId).toBeNull();
    // null once consumed -- it never returns the same value twice.
    expect(controller.consumePreviewStartPageId()).toBeNull();
  });

  it("consumePreviewStartPageId() returns null outside the editor view", () => {
    const { controller } = makeController();
    expect(controller.consumePreviewStartPageId()).toBeNull();
  });
});

describe("StoryUiController — readAcceptedMedia()", () => {
  it("returns the bytes and extension for an existing media file", async () => {
    const { storage, controller } = makeController();
    const seeded = await seedMinimalStory(storage, "demo", "Sample Story");
    await writeImage(storage, seeded.revision, "page-01");
    await controller.hydrate();

    const result = await controller.readAcceptedMedia("page-01");
    expect(result).not.toBeNull();
    expect(result?.ext).toBe("png");
    expect(result?.bytes.length).toBeGreaterThan(0);
  });

  it("returns null when there is no media file for that slug", async () => {
    const { storage, controller } = makeController();
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();

    expect(await controller.readAcceptedMedia("page-01")).toBeNull();
  });

  it("returns null outside the editor view", async () => {
    const { controller } = makeController();
    expect(await controller.readAcceptedMedia("page-01")).toBeNull();
  });
});

describe("StoryUiController — createPreviewSource()", () => {
  it("returns a PreviewSource wired to the same storage (loads the current story)", async () => {
    const { storage, controller } = makeController();
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();

    const source = controller.createPreviewSource();
    const result = await source.load();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.story.title).toBe("Sample Story");
    source.dispose();
  });
});

describe("StoryUiController — phone preview tab: the HostSession lives on the controller, not ended by switching tabs", () => {
  it("mobileRelayAvailable reflects StoryUiControllerDeps.relayUrl, fixed for the controller's lifetime", () => {
    const { controller: withRelay } = makeController({ relayUrl: "wss://relay.test" });
    expect(withRelay.mobileRelayAvailable).toBe(true);
    const { controller: withoutRelay } = makeController();
    expect(withoutRelay.mobileRelayAvailable).toBe(false);
  });

  it("setActiveTab(\"mobile\") auto-starts a HostSession exactly once, even across repeated visits to the tab", async () => {
    const { storage, controller, sessions } = makeControllerWithFakeSession();
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();

    controller.setActiveTab("mobile");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.startCalls).toBe(1);
    expect(asEditor(controller).mobilePreview).toEqual({ phase: "waiting-for-scan", pairingCode: "1234", viewerUrl: "https://example.test/preview.html#t=fake", errorMessage: null });

    // Switching away and back -- not a restart, still the same session.
    controller.setActiveTab("map");
    controller.setActiveTab("mobile");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.startCalls).toBe(1);
  });

  it("switching to map/preview tabs does not end the mobile session — state and connection both survive", async () => {
    const { storage, controller, sessions } = makeControllerWithFakeSession();
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();

    controller.setActiveTab("mobile");
    const session = sessions[0]!;
    session.simulatePairRequest();
    expect(asEditor(controller).mobilePreview?.phase).toBe("confirm-pairing");

    controller.setActiveTab("map");
    expect(session.endCalls).toBe(0);
    // mobilePreview stays on EditorState, never cleared just from switching tabs away -- switching
    // back to the "phone preview" tab (../ui/dom.ts's mobileView.update()) sees the same state, the
    // same QR/pairing code.
    expect(asEditor(controller).mobilePreview?.phase).toBe("confirm-pairing");

    controller.setActiveTab("preview");
    expect(session.endCalls).toBe(0);
    expect(asEditor(controller).mobilePreview?.phase).toBe("confirm-pairing");

    controller.setActiveTab("mobile");
    expect(session.endCalls).toBe(0);
    expect(sessions).toHaveLength(1); // Still the same session, not recreated
  });

  it("endMobilePreview() while still on the mobile tab immediately ends the old session and starts a fresh one (no stuck placeholder)", async () => {
    const { storage, controller, sessions } = makeControllerWithFakeSession();
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();

    controller.setActiveTab("mobile");
    expect(sessions[0]!.endCalls).toBe(0);

    controller.endMobilePreview();
    expect(sessions[0]!.endCalls).toBe(1);
    // Still on the "phone preview" tab -- a brand-new session is started automatically right away,
    // instead of leaving behind a mobilePreview: null "connecting" placeholder screen for the user
    // to deal with on their own (see the method note on endMobilePreview()).
    expect(sessions).toHaveLength(2); // A brand-new session, not a restart of the same one (same as HostSession.end()\u2019s existing documented behavior)
    expect(sessions[1]!.startCalls).toBe(1);
    expect(sessions[1]!.endCalls).toBe(0);
    expect(asEditor(controller).mobilePreview).not.toBeNull();
    expect(asEditor(controller).mobilePreview?.phase).toBe("waiting-for-scan");
  });

  it("endMobilePreview() while on a different tab just ends the session — no auto-restart until the user visits the mobile tab again", async () => {
    const { storage, controller, sessions } = makeControllerWithFakeSession();
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();

    controller.setActiveTab("mobile");
    controller.setActiveTab("map"); // Switch away -- the already-connected session stays as-is (see the test group above)

    controller.endMobilePreview();
    expect(sessions[0]!.endCalls).toBe(1);
    expect(sessions).toHaveLength(1); // No automatic restart of a second one
    expect(asEditor(controller).mobilePreview).toBeNull();

    controller.setActiveTab("mobile"); // The user switches back on their own -- only now is a brand-new one started
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.startCalls).toBe(1);
  });

  it("approveMobilePairing()/rejectMobilePairing() delegate to the current session", async () => {
    const { storage, controller, sessions } = makeControllerWithFakeSession();
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();
    controller.setActiveTab("mobile");
    const session = sessions[0]!;

    session.simulatePairRequest();
    controller.approveMobilePairing();
    expect(session.approveCalls).toBe(1);
    expect(asEditor(controller).mobilePreview?.phase).toBe("transferring");

    // Calling reject outside the confirm-pairing phase is a no-op (same existing guard as
    // HostSession) -- this verifies the controller simply forwards the call, without re-deciding
    // anything itself.
    controller.rejectMobilePairing();
    expect(session.rejectCalls).toBe(1);
    expect(asEditor(controller).mobilePreview?.phase).toBe("transferring"); // No change
  });

  it("leaving the editor view (story deleted → create view) ends the mobile session", async () => {
    const storage = new MemoryWorkspaceStorage();
    await storage.open();
    const focus = createFocusController(storage);
    const sessions: FakeHostSession[] = [];
    const controller = createStoryUiController({
      storage,
      focus,
      viewerOrigin: "https://example.test",
      relayUrl: "wss://relay.test",
      createHostSession: (deps) => {
        const session = new FakeHostSession(deps);
        sessions.push(session);
        return session;
      },
    });
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();
    controller.setActiveTab("mobile");
    expect(sessions[0]!.endCalls).toBe(0);

    // The story got deleted (e.g. an agent on another tab cleared out the workspace) -- the next
    // hydrate() determines the new view isn't "editor", and must proactively end the still-connected
    // session, rather than waiting for the browser to disconnect on its own before reacting.
    const snapshot = await storage.list();
    await storage.mutate({ expectedRevision: snapshot.revision, ops: snapshot.entries.map((e) => ({ op: "delete" as const, path: e.path })) });
    await controller.hydrate();

    expect(controller.getState().view).toBe("create");
    expect(sessions[0]!.endCalls).toBe(1);
  });

  it("leaving the editor view (invalid-yaml → error view) ends the mobile session", async () => {
    const storage = new MemoryWorkspaceStorage();
    await storage.open();
    const focus = createFocusController(storage);
    const sessions: FakeHostSession[] = [];
    const controller = createStoryUiController({
      storage,
      focus,
      viewerOrigin: "https://example.test",
      relayUrl: "wss://relay.test",
      createHostSession: (deps) => {
        const session = new FakeHostSession(deps);
        sessions.push(session);
        return session;
      },
    });
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();
    controller.setActiveTab("mobile");

    const snapshot = await storage.list();
    await storage.mutate({ expectedRevision: snapshot.revision, ops: [{ op: "write", path: "story.yaml", kind: "text", text: "not: [valid: yaml" }] });
    await controller.hydrate();

    expect(controller.getState().view).toBe("error");
    expect(sessions[0]!.endCalls).toBe(1);
  });

  it("re-hydrating while staying in the editor view (refresh, agent write) carries the live session's current state forward, not a stale/reset one", async () => {
    const { storage, controller, sessions } = makeControllerWithFakeSession();
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();
    controller.setActiveTab("mobile");
    sessions[0]!.simulatePairRequest();
    expect(asEditor(controller).mobilePreview?.phase).toBe("confirm-pairing");

    await controller.hydrate(); // The "refresh" button / an automatic hydrate triggered by an agent write

    expect(sessions).toHaveLength(1); // Not ended, not restarted
    expect(sessions[0]!.endCalls).toBe(0);
    expect(asEditor(controller).mobilePreview?.phase).toBe("confirm-pairing"); // State carried forward, not reset to null
    expect(asEditor(controller).activeTab).toBe("mobile"); // The tab also carries forward per the existing rule
  });

  it("setActiveTab(\"mobile\") is a no-op when relay is not configured — no session is created", async () => {
    const { storage, controller, sessions } = (() => {
      const sessions: FakeHostSession[] = [];
      const { storage, controller } = makeController({
        // relayUrl omitted -- mobileRelayAvailable is false.
        createHostSession: (deps) => {
          const session = new FakeHostSession(deps);
          sessions.push(session);
          return session;
        },
      });
      return { storage, controller, sessions };
    })();
    await seedMinimalStory(storage, "demo", "Sample Story");
    await controller.hydrate();

    controller.setActiveTab("mobile");
    expect(sessions).toHaveLength(0);
    expect(asEditor(controller).mobilePreview).toBeNull();
    expect(asEditor(controller).activeTab).toBe("mobile"); // The tab itself still switches, there just is no session
  });
});
