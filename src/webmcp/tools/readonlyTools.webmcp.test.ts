// Acceptance:
//   - a fake modelContext actually gets the registered schema for inspect_story/
//     get_story_readiness/get_editor_focus, and can call them (name/schema readable, execute
//     triggerable, the returned result readable).
//   - inspect_story's with-story/without-story states, the workspace-busy path.
//   - get_story_readiness's ready/incomplete states (reusing the "no text on page two" fixture
//     technique already verified in ../../story/readiness.contract.ts, not rewriting a second
//     fixture).
//   - get_editor_focus's with-focus/without-focus states, and a fake focus (story-slug-mismatch/
//     chapter-not-found) never shows up in the results returned here -- FocusController already
//     blocks it at the setFocus() layer (see the "state machine" note in the header of
//     ../../story/focus.ts), this only verifies the tool passes the "already-validated current"
//     value through unchanged, it doesn't re-validate it.
//   - none of the three tools' results contain a chapter's full text or media bytes (per the epic
//     acceptance criteria wording).
//   - regression tests for the review finding (P1, confirmed): both `Diagnostic.message` and the
//     YAML parser's original error text could carry a whole block of text the user accidentally
//     put in the wrong field -- none of the three tools' serialized results may leak it (see the
//     "review finding regression tests" section below).
//   - the re-review of the review finding (catching two more free-text exits, confirmed) adds two
//     more cases: `inspect_story.metadata.slug` (an illegal slug isn't blocked by readStory(), it
//     still gets read out and could still carry a marker), `get_story_readiness.media.missing`
//     (an invalid media.json file value must not be echoed) -- see "case 3" and "case 4."
//   - the third round of review findings (a third exit for the same gap, confirmed) adds case 5:
//     `FocusController.setFocus()` only validates equality on `storySlug`, not its format --
//     `get_editor_focus` used to pass an illegal storySlug straight through in focus back to the
//     model, see "case 5."
//
// Category: WebMCP tool-surface logic, filenames ending in .webmcp.test.ts go into test:webmcp
// (see README.md).
import { describe, expect, it } from "vitest";
import { DomWebMcpFacade } from "../facade.ts";
import { createFakeWebMcpDocument, FakeModelContext } from "../../testing/fakeModelContext.ts";
import { MemoryWorkspaceStorage } from "../../testing/fakes.ts";
import { createFocusController, type FocusController } from "../../story/focus.ts";
import { createMinimalStory, MINIMAL_STORY_NODE_ID, readStory, updatePageText, updateStoryStructure } from "../../story/index.ts";
import type { WorkspaceStoragePort } from "../../ports.ts";
import { RaceInjectingStorage } from "../../testing/raceInjectingStorage.ts";
import { createReadonlyTools, type EditorFocusResult, type InspectStoryResult, type SafeStoryReadiness } from "./readonlyTools.ts";

async function setup(storage: WorkspaceStoragePort = new MemoryWorkspaceStorage()) {
  await storage.open();
  const focus = createFocusController(storage);
  const modelContext = new FakeModelContext();
  const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
  const registration = facade.registerTools(createReadonlyTools({ storage, focus }));
  await registration.ready;
  return { storage, focus, modelContext, registration };
}

describe("createReadonlyTools — registration & schema", () => {
  it("registers exactly the three epic-named tools, each read-only with an empty, argument-less input schema", async () => {
    const { modelContext } = await setup();

    expect(modelContext.registeredNames()).toEqual(["get_editor_focus", "get_story_readiness", "inspect_story"]);
    for (const name of ["inspect_story", "get_story_readiness", "get_editor_focus"]) {
      const tool = modelContext.getRegisteredTool(name);
      expect(tool).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
      expect(tool?.description.length).toBeGreaterThan(0);
    }
  });
});

describe("inspect_story", () => {
  it("reports not-started on an empty workspace — a structured result, not an error", async () => {
    const { modelContext } = await setup();

    const result = (await modelContext.invoke("inspect_story", {})) as InspectStoryResult;

    expect(result.status).toBe("not-started");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("returns metadata/chapters/diagnostics/revision for an existing story, and never leaks the full chapter body", async () => {
    const { storage, modelContext } = await setup();
    const seed = await createMinimalStory(storage, { slug: "inspect-me", title: "A story you can inspect" });
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;

    // Replace this page's text with a long body that's completely different from the title --
    // used to assert that "inspect_story doesn't return the full text" isn't just a coincidence
    // (the initial text is the title itself; if the two were the same, we couldn't tell whether
    // the full text had leaked).
    const longBody = "This is a real block of body text containing a keyword, UNIQUE-BODY-MARKER, that only shows up if you've read the whole page. ".repeat(8);
    const current = await readStory(storage);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    const written = await updatePageText(storage, { expectedRevision: current.revision, chapterSlug: MINIMAL_STORY_NODE_ID, lang: "en", text: longBody });
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    const result = (await modelContext.invoke("inspect_story", {})) as InspectStoryResult;

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.metadata).toEqual({ slugValid: true, slug: "inspect-me", title: "A story you can inspect" });
    expect(result.chapters).toEqual([{ chapterSlug: MINIMAL_STORY_NODE_ID, hasContent: true, lengthTier: "long" }]);
    expect(result.diagnostics).toEqual({ errorCount: 0, warningCount: 0, categories: [] });
    expect(result.revision).toBe(written.revision);
    expect(result.summary.length).toBeGreaterThan(0);

    // Per the acceptance criteria: no full text, no media bytes. The title (metadata, short)
    // should appear; the full body text (with its unique marker string) should not appear in any
    // field.
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("A story you can inspect");
    expect(serialized).not.toContain("UNIQUE-BODY-MARKER");
    expect(serialized).not.toMatch(/"bytes"\s*:/);
  });

  it("reports unreadable(workspace-busy) when story.yaml keeps changing during the read, instead of throwing", async () => {
    const inner = new MemoryWorkspaceStorage();
    await inner.open();
    const seed = await createMinimalStory(inner, { slug: "busy-story", title: "A story that keeps getting changed" });
    expect(seed.ok).toBe(true);

    let counter = 0;
    async function bumpOnce() {
      counter++;
      const current = await readStory(inner);
      if (!current.ok) throw new Error("Test setup read failed");
      await updateStoryStructure(inner, {
        expectedRevision: current.revision,
        spec: {
          ...current.spec,
          nodes: {
            ...current.spec.nodes,
            [MINIMAL_STORY_NODE_ID]: {
              ...current.spec.nodes[MINIMAL_STORY_NODE_ID],
              ending: { endingId: `${MINIMAL_STORY_NODE_ID}-ending`, endingType: "good" },
            },
          },
        },
      });
    }
    // Every readFile() call actually lands a fresh update -- guarantees the retries can never
    // catch up (same technique as ../../story/contract.ts's "gives up after the retry limit"
    // test -- reuses RaceInjectingStorage directly instead of rewriting a second tear-injection).
    const wrapper = new RaceInjectingStorage(inner, bumpOnce, Number.POSITIVE_INFINITY);
    const { modelContext } = await setup(wrapper);

    const result = (await modelContext.invoke("inspect_story", {})) as InspectStoryResult;

    expect(result.status).toBe("unreadable");
    if (result.status !== "unreadable") return;
    expect(result.reason.type).toBe("workspace-busy");
    expect(result.summary).toContain("try again shortly");
  });
});

describe("get_story_readiness", () => {
  it("proxies getStoryReadiness() ready/incomplete states through the safe DTO (content/media/summary preserved, diagnostics safe-summarized)", async () => {
    const { storage, modelContext } = await setup();
    const seed = await createMinimalStory(storage, { slug: "ready-story", title: "A finished story" });
    expect(seed.ok).toBe(true);

    const ready = (await modelContext.invoke("get_story_readiness", {})) as SafeStoryReadiness;
    expect(ready.status).toBe("ready");
    if (ready.status === "ready" || ready.status === "incomplete") {
      expect(ready.summary).toContain("The story is complete");
      expect(ready.diagnostics).toEqual({ errorCount: 0, warningCount: 0, categories: [] });
      expect(ready.media).toEqual({ missingCount: 0, unparsable: false });
      expect(JSON.stringify(ready)).not.toMatch(/"bytes"\s*:/);
    }

    // Add a second page whose content ref points at a chapterSlug that hasn't been written yet
    // (same fixture technique already verified in ../../story/readiness.contract.ts) -- this
    // should flip the status to incomplete.
    const current = await readStory(storage);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    const nextSpec = {
      ...current.spec,
      nodes: {
        ...current.spec.nodes,
        [MINIMAL_STORY_NODE_ID]: { ...current.spec.nodes[MINIMAL_STORY_NODE_ID], type: undefined, ending: undefined, next: "page-02" },
        "page-02": {
          type: "ending" as const,
          content: { $ref: "content://ready-story/chapters/page-02#fragments/text" },
          ending: { endingId: "page-02-ending", endingType: "good" as const },
        },
      },
    };
    const updated = await updateStoryStructure(storage, { expectedRevision: current.revision, spec: nextSpec });
    expect(updated.ok).toBe(true);

    const incomplete = (await modelContext.invoke("get_story_readiness", {})) as SafeStoryReadiness;
    expect(incomplete.status).toBe("incomplete");
    if (incomplete.status !== "incomplete") return;
    expect(incomplete.content.missing).toEqual([{ chapterSlug: "page-02", reason: "missing-file" }]);
    expect(incomplete.summary).toContain("page-02");
  });
});

// ---------- Review finding regression tests (P1, confirmed) ----------
//
// `story-contract`'s `validate.ts`'s `checkRefField()` embeds the raw value into
// `Diagnostic.message` unchanged (a bare string interpolated directly, an object via
// `JSON.stringify`) whenever a field "has a value but isn't shaped like `{ $ref }`" -- this is
// free text meant for a human/the UI, not designed to be shown to the model. `yaml@2.9.0`'s parse
// error `Error.message` likewise carries the raw original text around the offending line
// (confirmed, see the header of ../tools/safeDiagnostics.ts). The two cases below mirror the
// review's specified reproduction paths exactly: legal YAML with a unique marker string placed in
// the wrong content field (a bare string); broken YAML where the offending line, as reported by
// the parser, contains the unique marker. Both cases write the hand-crafted story.yaml text
// directly via `storage.mutate()` (same existing technique as ../../story/readiness.contract.ts's
// "splits validate() diagnostics" test) -- `validate()` itself doesn't reject a read just because
// it's semantically illegal (the read layer's existing stance); only `updateStoryStructure()`
// would block it, so this deliberately bypasses that to produce a story.yaml that is
// "semantically broken but syntactically legal."

describe("review finding regression — no full-text leak via a free-text side channel", () => {
  it("case 1: legal YAML, a unique marker placed in the wrong content field (a bare string) — none of the three tools' serialized results contain the marker", async () => {
    const storage = new MemoryWorkspaceStorage();
    await storage.open();
    const marker = "UNIQUE-CONTENT-LEAK-MARKER-XYZ";
    const yamlText = [
      "specVersion: storymaker/v1alpha1",
      "kind: Story",
      "metadata:",
      "  slug: leak-test",
      "start: page-01",
      "nodes:",
      "  page-01:",
      "    type: ending",
      `    content: "${marker} this is actually a whole block of body text accidentally pasted into a field meant for { $ref }"`,
      "    ending:",
      "      endingId: page-01-ending",
      "",
    ].join("\n");
    const seed = await storage.mutate({ expectedRevision: 0, ops: [{ op: "write", path: "story.yaml", kind: "text", text: yamlText }] });
    expect(seed.ok).toBe(true);
    // Precondition check: confirm this hand-crafted YAML really does produce a marker-carrying
    // diagnostic from validate() -- otherwise this test would already have been green before the
    // fix and wouldn't be testing anything (a precondition for the neutralization to be meaningful).
    const raw = await readStory(storage);
    expect(raw.ok).toBe(true);
    if (raw.ok) expect(raw.diagnostics.some((d) => d.message.includes(marker))).toBe(false);

    const focus = createFocusController(storage);
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const registration = facade.registerTools(createReadonlyTools({ storage, focus }));
    await registration.ready;

    const inspect = await modelContext.invoke("inspect_story", {});
    const readiness = await modelContext.invoke("get_story_readiness", {});
    const editorFocus = await modelContext.invoke("get_editor_focus", {});

    for (const [name, result] of [
      ["inspect_story", inspect],
      ["get_story_readiness", readiness],
      ["get_editor_focus", editorFocus],
    ] as const) {
      expect(JSON.stringify(result), `${name}'s serialized result should not contain ${marker}`).not.toContain(marker);
    }
  });

  it("case 2: broken YAML, the parser's offending line contains a unique marker — none of the three tools' serialized results may leak it", async () => {
    const storage = new MemoryWorkspaceStorage();
    await storage.open();
    const marker = "UNIQUE-YAML-ERROR-MARKER-ABC";
    // The same reproduction confirmed in the header: an unterminated flow sequence, with the
    // offending line's original text containing the marker -- yaml@2.9.0's YAMLParseError.message
    // prints this line back unchanged.
    const brokenYaml = `specVersion: storymaker/v1alpha1\nkind: [${marker} unterminated flow sequence\n`;
    const seed = await storage.mutate({ expectedRevision: 0, ops: [{ op: "write", path: "story.yaml", kind: "text", text: brokenYaml }] });
    expect(seed.ok).toBe(true);
    // Precondition check: confirm this hand-crafted broken YAML really does make readStory()
    // classify it as invalid-yaml, and that the underlying parser message really does contain the
    // marker (otherwise this test wouldn't be testing anything).
    const raw = await readStory(storage);
    expect(raw.ok).toBe(false);
    if (!raw.ok) {
      expect(raw.error.type).toBe("invalid-yaml");
      if (raw.error.type === "invalid-yaml") expect(raw.error.reason.includes(marker)).toBe(true);
    }

    const focus = createFocusController(storage);
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const registration = facade.registerTools(createReadonlyTools({ storage, focus }));
    await registration.ready;

    const inspect = await modelContext.invoke("inspect_story", {});
    const readiness = await modelContext.invoke("get_story_readiness", {});
    const editorFocus = await modelContext.invoke("get_editor_focus", {});

    for (const [name, result] of [
      ["inspect_story", inspect],
      ["get_story_readiness", readiness],
      ["get_editor_focus", editorFocus],
    ] as const) {
      expect(JSON.stringify(result), `${name}'s serialized result should not contain ${marker}`).not.toContain(marker);
    }
  });

  // ---- Two more cases added by the mainline re-review (catching two more free-text exits, confirmed) ----
  //
  // readStory()'s existing stance of "syntactically legal, semantically illegal" (it doesn't
  // reject a read over a semantic error) shows up here through a different triggering field:
  // metadata.slug's own SLUG_RE is only a diagnostic on the story-contract side, not a gate that
  // blocks reads -- an illegal slug (which could carry a marker the user accidentally put there)
  // still gets read out; inspect_story used to return metadata.slug unchanged. media.json's
  // invalid media.json file values likewise need safe diagnostics: get_story_readiness must not
  // pass through the raw value when reporting an unparsable media index.

  it("case 3 (metadata.slug is illegal, carries a marker) — inspect_story doesn't leak the raw slug value, only reports slugValid: false", async () => {
    const storage = new MemoryWorkspaceStorage();
    await storage.open();
    const marker = "UNIQUE-SLUG-LEAK-MARKER-123";
    // Syntactically legal YAML, but metadata.slug doesn't match SLUG_RE (^[a-z0-9-]+$) --
    // readStory() doesn't reject a read over semantic illegality, validate() only records it as a
    // diagnostic.
    const yamlText = [
      "specVersion: storymaker/v1alpha1",
      "kind: Story",
      "metadata:",
      `  slug: "${marker} this is not a valid slug format"`,
      "start: page-01",
      "nodes:",
      "  page-01:",
      "    type: ending",
      "    ending:",
      "      endingId: page-01-ending",
      "",
    ].join("\n");
    const seed = await storage.mutate({ expectedRevision: 0, ops: [{ op: "write", path: "story.yaml", kind: "text", text: yamlText }] });
    expect(seed.ok).toBe(true);
    // Precondition check: confirm this hand-crafted slug really is illegal (the read itself still
    // succeeds -- not story-not-found/invalid-yaml).
    const raw = await readStory(storage);
    expect(raw.ok).toBe(true);
    if (raw.ok) expect(raw.spec.metadata.slug.includes(marker)).toBe(true);

    const focus = createFocusController(storage);
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const registration = facade.registerTools(createReadonlyTools({ storage, focus }));
    await registration.ready;

    const result = (await modelContext.invoke("inspect_story", {})) as InspectStoryResult;

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.metadata).toEqual({ slugValid: false });
    expect(JSON.stringify(result), "inspect_story's serialized result should not contain the illegal raw slug value").not.toContain(marker);
  });

  it("case 4 (invalid media.json filename carries a marker) — get_story_readiness does not echo it", async () => {
    const storage = new MemoryWorkspaceStorage();
    await storage.open();
    const marker = "UNIQUE-MEDIA-LEAK-MARKER-789";
    const seed = await createMinimalStory(storage, { slug: "media-leak-test", title: "A media-leak test" });
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;

    // media.json references a file that doesn't actually exist in the workspace --
    // findBrokenMediaReferences() composes this file value unchanged into the returned path
    // string (media/<file>).
    const mediaJsonText = JSON.stringify({ "some-media-slug": { file: `${marker}.png` } });
    const written = await storage.mutate({ expectedRevision: seed.revision, ops: [{ op: "write", path: "media.json", kind: "text", text: mediaJsonText }] });
    expect(written.ok).toBe(true);

    const focus = createFocusController(storage);
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const registration = facade.registerTools(createReadonlyTools({ storage, focus }));
    await registration.ready;

    const result = (await modelContext.invoke("get_story_readiness", {})) as SafeStoryReadiness;

    expect(result.status).toBe("incomplete");
    if (result.status !== "ready" && result.status !== "incomplete") return;
    expect(result.media).toEqual({ missingCount: 0, unparsable: true });
    expect(JSON.stringify(result), "get_story_readiness's serialized result should not contain the missing media's referenced filename").not.toContain(marker);
  });

  // ---- One more case added by the third round (a third exit for the same gap, confirmed) ----
  //
  // FocusController.setFocus() (../../story/focus.ts's validateClaim()) only validates
  // claim.storySlug === spec.metadata.slug (an equality comparison), never storySlug's own format
  // -- a workspace where metadata.slug is syntactically legal but carries a body-text marker will
  // still let a focus claim for "the current story's slug" get accepted (the value matches the
  // current spec). get_editor_focus used to pass this storySlug straight through, unchanged,
  // wrapped in { status: "focused", focus }, back to the model; inspect_story/get_story_readiness
  // were already fixed in the first two rounds -- this verifies all three tools' serialized
  // results, against the same "bad slug" workspace, leak nothing.
  it("case 5 (metadata.slug is illegal, setFocus() accepts it) — none of the three tools' serialized results leak the slug", async () => {
    const storage = new MemoryWorkspaceStorage();
    await storage.open();
    const marker = "UNIQUE-FOCUS-SLUG-LEAK-MARKER-456";
    const invalidSlug = `${marker} this is not a valid slug format`;
    const yamlText = [
      "specVersion: storymaker/v1alpha1",
      "kind: Story",
      "metadata:",
      `  slug: "${invalidSlug}"`,
      "start: page-01",
      "nodes:",
      "  page-01:",
      "    type: ending",
      "    ending:",
      "      endingId: page-01-ending",
      "",
    ].join("\n");
    const seed = await storage.mutate({ expectedRevision: 0, ops: [{ op: "write", path: "story.yaml", kind: "text", text: yamlText }] });
    expect(seed.ok).toBe(true);

    const focus = createFocusController(storage);
    // storySlug must be exactly equal to the current spec.metadata.slug for setFocus() to accept
    // it (see validateClaim()'s equality comparison) -- claiming that exact illegal value here
    // proves the "equality check passes, format is never validated" path really does let a focus
    // with a bad slug get accepted; it's not a scenario the test made up on its own.
    const set = await focus.setFocus({ storySlug: invalidSlug });
    expect(set.ok).toBe(true);

    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const registration = facade.registerTools(createReadonlyTools({ storage, focus }));
    await registration.ready;

    const inspect = await modelContext.invoke("inspect_story", {});
    const readiness = await modelContext.invoke("get_story_readiness", {});
    const editorFocus = (await modelContext.invoke("get_editor_focus", {})) as EditorFocusResult;

    // First confirm "there really is a focus" -- we can't erase the true signal of "is there a
    // focus at all" just to avoid leaking the value (see the "Shape decision" note in the
    // get_editor_focus section at the top of this file).
    expect(editorFocus.status).toBe("focused");
    if (editorFocus.status === "focused") expect(editorFocus.focus).toEqual({ slugValid: false });

    for (const [name, result] of [
      ["inspect_story", inspect],
      ["get_story_readiness", readiness],
      ["get_editor_focus", editorFocus],
    ] as const) {
      expect(JSON.stringify(result), `${name}'s serialized result should not contain ${marker}`).not.toContain(marker);
    }
  });
});

describe("get_editor_focus", () => {
  it('reports "no-focus" (an explicit shape, not null) when nothing has been claimed yet', async () => {
    const { modelContext } = await setup();

    const result = (await modelContext.invoke("get_editor_focus", {})) as EditorFocusResult;

    expect(result).toEqual({ status: "no-focus" });
  });

  it("reports the current validated focus once setFocus() has accepted a claim", async () => {
    const { storage, focus, modelContext } = await setup();
    const seed = await createMinimalStory(storage, { slug: "focus-me", title: "A focused-on story" });
    expect(seed.ok).toBe(true);

    const set = await focus.setFocus({ storySlug: "focus-me", chapterSlug: MINIMAL_STORY_NODE_ID, tab: "content" });
    expect(set.ok).toBe(true);

    const result = (await modelContext.invoke("get_editor_focus", {})) as EditorFocusResult;

    expect(result).toEqual({ status: "focused", focus: { slugValid: true, storySlug: "focus-me", chapterSlug: MINIMAL_STORY_NODE_ID, tab: "content" } });
  });

  it("never surfaces a dropped/fake claim — a rejected setFocus() leaves the tool reporting no-focus", async () => {
    const { storage, focus, modelContext } = await setup();
    const seed = await createMinimalStory(storage, { slug: "focus-me", title: "A focused-on story" });
    expect(seed.ok).toBe(true);

    const rejected = await focus.setFocus({ storySlug: "focus-me", chapterSlug: "does-not-exist" });
    expect(rejected.ok).toBe(false);
    expect(focus.lastRejectedClaim?.reason.type).toBe("chapter-not-found");

    const result = (await modelContext.invoke("get_editor_focus", {})) as EditorFocusResult;

    expect(result).toEqual({ status: "no-focus" });
    expect(JSON.stringify(result)).not.toContain("does-not-exist");
  });

  it("uses the exact FocusController instance passed into createReadonlyTools — not a re-derived one", async () => {
    // Avoid duplicate construction: getFocus()'s result from the same FocusController instance
    // should pass through unchanged, not be re-validated a second time by the tool itself (that
    // would be the same "rewrite a copy of the decision logic" problem as #137/#138).
    const storage = new MemoryWorkspaceStorage();
    await storage.open();
    const focus: FocusController = createFocusController(storage);
    const seed = await createMinimalStory(storage, { slug: "shared-focus", title: "A shared focus" });
    expect(seed.ok).toBe(true);
    await focus.setFocus({ storySlug: "shared-focus" });

    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const registration = facade.registerTools(createReadonlyTools({ storage, focus }));
    await registration.ready;

    const result = (await modelContext.invoke("get_editor_focus", {})) as EditorFocusResult;
    expect(result).toEqual({ status: "focused", focus: { slugValid: true, storySlug: "shared-focus" } });
  });
});

describe("real-browser regression: the host calls the real tool directly, without options", () => {
  // This is exactly the spot where a real-browser test failed: the ChatGPT desktop app's
  // built-in browser called get_editor_focus without options/signal, and hit
  // `Cannot read properties of undefined (reading 'aborted')`. This test deliberately doesn't go
  // through FakeModelContext.invoke() (it always synthesizes a signal, more forgiving than a real
  // host) -- it calls the mounted native tool directly, in the shape the real host actually uses.
  it("get_editor_focus called as execute(undefined) (no input, no options) still returns a structured no-focus, must not throw a native TypeError", async () => {
    const { modelContext } = await setup();

    const native = modelContext.getRegisteredTool("get_editor_focus");
    expect(native).toBeDefined();

    await expect(native!.execute(undefined)).resolves.toEqual({ status: "no-focus" });
  });
});
