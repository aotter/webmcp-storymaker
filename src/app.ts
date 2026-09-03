// The single composition root. Production (src/main.ts) and the tests
// (*.workspace.test.ts) share the same createApp() — the only difference is which ports get fed
// in: the real adapters, or the memory fakes (src/testing/fakes.ts).
//
// This file doesn't implement the story UI or the agent runtime — it only handles "wire up the
// ports at startup, release resources at shutdown," and the results of starting/stopping must be
// observable.
//
// App also owns `focus` (the FocusController from ./story/focus.ts) — focus is "the app's
// in-memory state" (what the page currently claims, an auxiliary context validated by the
// program, not story content — see focus.ts's file header for details), and like storage/webMcp,
// it belongs to this App instance's lifecycle; the composition root is its one and only assembly
// point. Doesn't touch the UI: this file just hooks the controller up, there's no caller for it
// here.
//
// `AppPorts.webMcp` (type `WebMcpPort`, see ./webmcp/index.ts) absorbed what used to be a
// separate "is capability present" flag into the full WebMCP lifecycle, including
// `registerTools()` (see ./webmcp/facade.ts's header, "port-absorption rationale").
// `webMcpAvailable` reads the port's `isAvailable()` directly.
//
// `start()` attaches `createReadonlyTools()` (inspect_story/get_story_readiness/get_editor_focus)
// and `createWriteTools()` (create_story/update_story_structure/update_page_text) from
// ./webmcp/tools/, combined into one `registerTools()` call sharing a single ready/error guard.
// The UI (`../ui/controller.ts`) has no idea this batch of tools exists, and doesn't need to —
// once an agent writes to the workspace through these tools, the UI's own next self-initiated
// save/hydrate hits the existing OCC revision-conflict mechanism and naturally reloads the latest
// content (see README.md's "eventual consistency" section; this file does no push/subscribe of
// any kind).
//
// The call to `ports.webMcp.registerTools()` doesn't check `isAvailable()` first — when there's
// no capability, the facade returns a zero-registration no-op registration on its own (see
// ./webmcp/facade.ts's header), so the composition root doesn't need to check twice.
// `registration.ready` is deliberately **not awaited**: whether the tools attach successfully
// doesn't block `start()` from completing, and doesn't block the fallback UI (docs/architecture.md's
// progressive enhancement — WebMCP has never been a required path), but the rejection also must
// not be silently swallowed — `ready` itself is exposed as-is to callers via the
// `webMcpToolsReady` field for them to await on their own, and a separate `.then()` writes the
// failure result into the synchronously-readable `webMcpToolsError`, for callers that don't want
// to await (e.g. UI polling) to query.
//
// Two behavioral guarantees around start()/stop() re-entry (see ./app.webmcp.test.ts):
//
//   A stale ready-rejection from a superseded registration must not overwrite the current error
//   state. `DomWebMcpFacade.dispose()` (./webmcp/facade.ts) only awaits `allSettled`, not `ready`
//   — `ready` itself, along with the `.then()` handler attached here, can settle one or two
//   microtasks after `stop()`. Sequence: `start()`₁ -> `stop()` (dispose completes, but
//   registration₁'s `ready`/`.then()` hasn't actually run yet) -> `start()`₂ resets
//   `webMcpToolsError = undefined` and its own second round succeeds cleanly -> registration₁'s
//   `ready` only *then* rejects due to its real failure -> if the old handler writes
//   unconditionally, it overwrites the correct "actually nothing is failing right now" state with
//   a now-stale error, and the caller ends up misled. Fix: the handler compares
//   `this.#toolsRegistration !== registration` before writing (a reference guard) — if it's not
//   the current one, discard it, don't write. Reference equality was chosen instead of a separate
//   `#generation` counter like `./story/focus.ts`'s `setFocus()` uses, because at any given
//   moment there can only ever be one in-flight registration here (the re-entry guard below
//   guarantees `start()` can't re-enter and stack up a second simultaneously-live registration),
//   unlike `setFocus()` which has to handle "multiple calls in flight at once, which one wins"
//   ordering. Simply comparing "is the registration this handler corresponds to still the one
//   currently attached" is already complete and correct here (`./story/focus.ts`'s `getFocus()`'s
//   `claimAtStart` reference comparison is the same trick's sister precedent, not a newly invented
//   technique). The semantics of `webMcpToolsReady` itself: what a caller gets by `await`ing it
//   is always "whichever round is current at the moment of that call"; if a caller stashes the
//   promise early and only awaits it after a `stop()`/`start()`, what it gets back is that old
//   round's own settle result (whether that old registration should still count is the caller's
//   own consequence of choosing to keep holding onto that promise, not something this field is
//   meant to fix by swapping out a promise that's already been handed out — this field doesn't do
//   that).
//
//   Calling `start()` repeatedly without a `stop()` in between must not leak the previous
//   registration. Simply overwriting `#toolsRegistration` would mean the previous round's
//   registration is never disposed — the tools would stay attached to modelContext forever, and a
//   later `stop()` would only clean up the second round, silently looking like success. Fix
//   chosen: at the top of `start()`, `if (this.status === "started") return`, an idempotent no-op
//   — not "dispose the current registration first, then re-register": re-entering `start()` isn't
//   part of this App's normal usage contract (a caller shouldn't be calling `start()` twice in a
//   row without a `stop()` in between), and disposing-and-rebuilding would silently tear down and
//   rebuild a batch of tool registrations that might be actively in use by an agent, in a
//   situation where the caller may have had no intention of restarting at all (facade's
//   `dispose()` doesn't cancel an in-flight `execute()` call, but it does unregister the tool from
//   modelContext, so the agent's next call would simply find the tool gone) — that side effect is
//   more surprising than plain "re-entry is a no-op, that's the caller's own problem," and doesn't
//   fit the stance of "the earlier and more honestly an error surfaces, the better." The no-op is
//   simpler and more honestly reflects "you shouldn't be calling it this way," and needs no new
//   state or branching logic. `storage.open()` is already idempotent on its own (see
//   `../testing/fakes.ts`'s `MemoryWorkspaceStorage.open()`/each adapter's implementation) — this
//   guard means it doesn't even get the chance to be called a second time; behavior is unchanged
//   (still idempotent, just now it's not even invoked twice).
import type { WorkspaceStoragePort } from "./ports.ts";
import type { WebMcpPort, WebMcpRegistration } from "./webmcp/index.ts";
import { WebMcpRegistrationError } from "./webmcp/index.ts";
import { createFocusController, type FocusController } from "./story/focus.ts";
import { createReadonlyTools } from "./webmcp/tools/readonlyTools.ts";
import { createWriteTools } from "./webmcp/tools/writeTools.ts";

export type AppStatus = "idle" | "started" | "stopped";

export interface AppPorts {
  storage: WorkspaceStoragePort;
  webMcp: WebMcpPort;
  /** Forwarded to `./webmcp/tools/writeTools.ts`'s
   * `onMutated` hook — see that file's `WriteToolsDeps.onMutated` for details. Optional; the
   * composition root (../main.ts) wires it to the UI controller's `hydrate()`;
   * tests (*.workspace.test.ts) don't need to pass it. */
  onWorkspaceMutated?: () => void;
}

export interface App {
  /** The current start status — tests use this to observe whether start()/stop() actually took
   * effect. */
  readonly status: AppStatus;
  /** WebMCP availability as detected at the moment of `start()` (see docs/architecture.md,
   * progressive enhancement). */
  readonly webMcpAvailable: boolean;
  /** The number of tools this round of `start()` actually assembled and
   * handed to `registerTools()` (the combined total of `createReadonlyTools()` +
   * `createWriteTools()`, currently 7) — used by the top-bar WebMCP connection status pill, which
   * shows "AI assistant connected" plus the tool count, so the UI layer doesn't
   * need to hard-code a number separately, nor does it need to reverse-query
   * `document.modelContext` (the spec's `ModelContext` interface has no `getTools()`-style
   * introspection method to begin with — see ../webmcp/types.ts's `WebMcpModelContext` header)
   * — this number is the only authoritative source for "how many did we actually attach." When
   * `webMcpAvailable` is `false`, this is always 0 (the facade returns zero registrations for an
   * absent `document.modelContext`, see ./webmcp/facade.ts's NOOP_REGISTRATION), which does
   * not mean "every attached tool failed." */
  readonly toolCount: number;
  /** The auxiliary context for "where is the UI/agent currently looking" (./story/focus.ts) —
   * each App instance has its own controller, bound to that instance's
   * storage; it's not a global singleton. */
  readonly focus: FocusController;
  /** The `ready` from this batch of readonly tools' `registerTools()` call — `start()`
   * completes without awaiting it (so it doesn't block the fallback UI); a caller (a test, or
   * future UI) that wants to confirm these tools have really attached awaits this field itself.
   * Each `start()` swaps in a new promise for that call. When webMcp is unavailable, the facade's
   * no-op registration resolves immediately. */
  readonly webMcpToolsReady: Promise<void>;
  /** The observable snapshot for when the `webMcpToolsReady` above rejects — lets a caller check
   * "did attaching tools fail this round" without awaiting; `undefined` while `ready` is
   * resolved or hasn't settled yet. `stop()`/the next `start()` don't automatically clear this
   * field ("it failed last time" is itself meaningful history), but a new `start()` resets it to
   * `undefined` right away, reflecting "no known failure yet this round." **Only reflects the
   * current batch's failure** — if a round has already been superseded by a `stop()`/new
   * `start()` and that old round's `ready` only then rejects late (see the stale-rejection guard
   * note in this class's header above), that late failure is discarded and not written into this
   * field, so it doesn't contaminate the "current" state. */
  readonly webMcpToolsError: WebMcpRegistrationError | undefined;
  /** Idempotent: when `status` is already `"started"`, this is a plain no-op (see the re-entry
   * guard note in this class's header above) — a caller shouldn't call this twice in a row without a `stop()`
   * first; re-entry is quietly ignored and won't stack up a second, leaked batch of WebMCP tool
   * registrations. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

class ComposedApp implements App {
  status: AppStatus = "idle";
  webMcpAvailable = false;
  toolCount = 0;
  webMcpToolsReady: Promise<void> = Promise.resolve();
  webMcpToolsError: WebMcpRegistrationError | undefined;
  readonly focus: FocusController;
  #toolsRegistration: WebMcpRegistration | undefined;

  constructor(private readonly ports: AppPorts) {
    this.focus = createFocusController(ports.storage);
  }

  async start(): Promise<void> {
    // Re-entry guard: re-entry is an idempotent no-op — see this class's header above.
    if (this.status === "started") return;

    await this.ports.storage.open();
    this.webMcpAvailable = this.ports.webMcp.isAvailable();

    this.webMcpToolsError = undefined;
    const tools = [
      ...createReadonlyTools({ storage: this.ports.storage, focus: this.focus }),
      ...createWriteTools({ storage: this.ports.storage, onMutated: this.ports.onWorkspaceMutated }),
    ];
    // When webMcpAvailable is false, the facade returns zero registrations (NOOP_REGISTRATION),
    // but that doesn't change the length of the `tools` array assembled here — the reported
    // count is always fixed at 0 in that case, not "how many we wanted to attach" but "how many
    // are actually attached right now" (see the App.toolCount header comment above).
    this.toolCount = this.webMcpAvailable ? tools.length : 0;
    const registration = this.ports.webMcp.registerTools(tools);
    this.#toolsRegistration = registration;
    this.webMcpToolsReady = registration.ready;
    // Not awaiting registration.ready — see App.webMcpToolsReady/this class's header above.
    // Failure is recorded into webMcpToolsError, not swallowed (the facade already attaches an
    // empty catch internally to avoid an unhandled rejection; this one is purely to write into
    // this observable field, the two don't conflict).
    registration.ready.then(
      () => undefined,
      (error: unknown) => {
        // Stale-rejection guard: this handler is bound to "whichever registration was current at call
        // time" — if #toolsRegistration is no longer that one by now (a stop()/another start()
        // happened in between), this rejection is a late signal from an old round, meaningless
        // for "now," so it's discarded and not written (see this class's header above, the same
        // claimAtStart reference-comparison trick as ./story/focus.ts's getFocus()).
        if (this.#toolsRegistration !== registration) return;
        this.webMcpToolsError = error instanceof WebMcpRegistrationError ? error : new WebMcpRegistrationError([{ name: "(unknown)", reason: error }]);
      },
    );

    this.status = "started";
  }

  async stop(): Promise<void> {
    if (this.#toolsRegistration) {
      await this.#toolsRegistration.dispose();
      this.#toolsRegistration = undefined;
    }
    await this.ports.storage.close();
    this.status = "stopped";
  }
}

export function createApp(ports: AppPorts): App {
  return new ComposedApp(ports);
}
