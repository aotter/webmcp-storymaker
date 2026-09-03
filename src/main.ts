// Production entry point, the one real call site of the composition root (src/app.ts). Shares
// the same createApp() as the tests — this file swaps in the real adapters (workspace storage:
// see src/adapters/indexeddbWorkspaceStorage.ts, others: see src/adapters.ts), while tests swap
// in the memory fakes (src/testing/fakes.ts).
//
// The AI-only operations interface (src/ui/, see docs/architecture.md's "WebMCP is the only
// write path") is mounted onto the screen here: the UI controller (src/ui/controller.ts) only
// consumes storage/focus, and doesn't know or care whether document.modelContext exists — so
// there's no need to wait for app.webMcpAvailable before mounting the UI: when there's no WebMCP
// agent connected, the page still displays the current story map/preview in full, it's just that
// no write path is usable. That's why the story/readiness modules end up in the production
// bundle (smoke:build's dist scan actually verifies this stays clean).
import { createApp } from "./app.ts";
import { IndexedDbWorkspaceStorage } from "./adapters/indexeddbWorkspaceStorage.ts";
import { DomWebMcpFacade } from "./webmcp/index.ts";
import { createStoryUiController } from "./ui/controller.ts";
import { mountStoryUi } from "./ui/dom.ts";
import "./ui/style.css";

const storage = new IndexedDbWorkspaceStorage();
// The controller can only be built after
// app.start() completes (it needs app.focus), but the onWorkspaceMutated hook has to be handed
// to app.ts at the moment createApp() is called (see that file's AppPorts.onWorkspaceMutated for
// details) — a mutable outer reference breaks this chicken-and-egg ordering problem: the hook
// itself only ever gets called once a WebMCP tool has actually succeeded at writing, and that can
// only happen after app.start() has completed and controller has been assigned (a caller can't
// possibly reach any registered tool before start() completes).
let controller: import("./ui/controller.ts").StoryUiController | undefined;
const app = createApp({
  storage,
  webMcp: new DomWebMcpFacade(),
  onWorkspaceMutated: () => void controller?.hydrate(),
});

void app.start().then(
  () => {
    const root = document.getElementById("app");
    if (!root) return;
    controller = createStoryUiController({
      storage,
      focus: app.focus,
      // HostSession lives in controller, and this is where
      // (the composition root, which already touches DOM/window directly) location.origin/the
      // relay address are provided once, up front — controller itself never touches these two
      // globals, preserving the existing "controller has zero browser APIs" testing discipline
      // (see ./ui/controller.ts's header).
      viewerOrigin: location.origin,
      relayUrl: import.meta.env.VITE_PREVIEW_RELAY_URL as string | undefined,
    });
    mountStoryUi(root, controller, { available: app.webMcpAvailable, toolCount: app.toolCount });
  },
  (error: unknown) => {
    console.error("StoryMaker failed to start", error);
    const root = document.getElementById("app");
    if (root) root.textContent = "Something went wrong. Please refresh the page and try again.";
  },
);

// One of the three places HostSession.end() is triggered from (see the
// note above the HostSession class in ./preview/hostSession.ts) — when the tab is about to
// unload, regardless of which screen/tab the user is currently sitting on, proactively close any
// WebSocket that might still be connected, rather than leaving it to the browser's own
// disconnect to slowly trigger applyConnectionLost() on its own. pagehide is more reliable on
// modern browsers (including under bfcache), with beforeunload as a second line of defense — both
// call the same idempotent endMobilePreview(), so calling it twice causes no issue.
window.addEventListener("pagehide", () => controller?.endMobilePreview());
window.addEventListener("beforeunload", () => controller?.endMobilePreview());
