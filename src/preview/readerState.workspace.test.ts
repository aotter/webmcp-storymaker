// ./readerState.ts's reading-position state machine - pure
// functions, zero DOM, testing the transition results directly.
import { describe, expect, it } from "vitest";
import type { PreviewStory } from "./snapshot.ts";
import { canGoBack, currentPage, currentPageId, goBack, goTo, initReaderState, restart } from "./readerState.ts";

const STORY: PreviewStory = {
  title: "Sample Story",
  startPageId: "p1",
  pages: [
    { id: "p1", text: "Page one", choices: [], next: "p2" },
    {
      id: "p2",
      text: "A branching page",
      choices: [
        { label: "Go left", target: "p3" },
        { label: "Go right", target: "p4" },
      ],
    },
    { id: "p3", text: "Ending A", choices: [] },
    { id: "p4", text: "Ending B", choices: [] },
  ],
};

describe("readerState", () => {
  it("initReaderState() starts at startPageId with a single-entry stack", () => {
    const state = initReaderState(STORY);
    expect(currentPageId(state)).toBe("p1");
    expect(canGoBack(state)).toBe(false);
  });

  it("goTo() pushes the stack, goBack() returns to the previous entry", () => {
    let state = initReaderState(STORY);
    state = goTo(state, "p2");
    expect(currentPageId(state)).toBe("p2");
    expect(canGoBack(state)).toBe(true);

    state = goTo(state, "p3");
    expect(currentPageId(state)).toBe("p3");

    state = goBack(state);
    expect(currentPageId(state)).toBe("p2"); // Returns to "wherever we just came from," not some structurally fixed previous page

    state = goBack(state);
    expect(currentPageId(state)).toBe("p1");
    expect(canGoBack(state)).toBe(false);
  });

  it("goBack() is a no-op once the stack has only one entry left", () => {
    const state = initReaderState(STORY);
    const after = goBack(state);
    expect(after).toEqual(state);
  });

  it("goTo() down different branches from a branching page - goBack() returns to the branching page itself, not the other branch", () => {
    let state = initReaderState(STORY);
    state = goTo(state, "p2");
    state = goTo(state, "p3"); // chose "Go left"

    state = goBack(state);
    expect(currentPageId(state)).toBe("p2");
  });

  it("restart() (back to the beginning) is equivalent to a fresh initReaderState() - the stack resets to just startPageId", () => {
    let state = initReaderState(STORY);
    state = goTo(state, "p2");
    state = goTo(state, "p3");

    state = restart(STORY);
    expect(state).toEqual(initReaderState(STORY));
    expect(canGoBack(state)).toBe(false);
  });

  it("currentPage() returns the current page's full content", () => {
    let state = initReaderState(STORY);
    state = goTo(state, "p2");
    expect(currentPage(state, STORY)?.text).toBe("A branching page");
  });

  it("currentPage() returns undefined for an id that doesn't exist (defensive, should never happen in theory)", () => {
    const state = { path: ["not-a-real-page"] };
    expect(currentPage(state, STORY)).toBeUndefined();
  });
});
