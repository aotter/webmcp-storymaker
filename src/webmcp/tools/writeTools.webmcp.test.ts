// Acceptance:
//   - the agent tools can create and modify a minimal story; a second conflicting update, an
//     unknown page, and a broken StorySpec all fail with the data unchanged; the UI/reload reads
//     the same result after a tool call.
//   - leak regression: a marker string, via ① a broken spec's field value, ② the unknown
//     chapterSlug parameter itself (both the chapter-not-found shape and the shape that triggers
//     the workspace path allowlist's hidden-segment rejection), ③ the error path for
//     over-length text -- none of the write tools' serialized error responses contain the marker
//     (see the "Data minimization" note in the header of ./writeTools.ts).
//   - create_story is rejected on a non-empty workspace.
//
// Regression tests for the spec-input-sanitization fix (see the "Spec input sanitization +
// execute-wide try/catch" note in the header of ./writeTools.ts):
//   - `nodes.<id>=null`/`choices.<key>=null` (legal JSON, `validate()` throws an
//     uncaught TypeError accessing a null property), deep nesting (plain JSON, no cycle needed,
//     `stringifyYaml()`'s recursion blows the stack with a RangeError) -- four cases via
//     `update_story_structure` calls, all returning a fixed category, the data fingerprint
//     unchanged, and `readStory()` (the equivalent read to inspect_story) still working
//     afterward.
//   - a circular-reference object (a hand-built JS object; the `yaml` package's
//     stringify tolerates the cycle with an anchor, no throw) -- likewise via
//     `update_story_structure` calls, returning a fixed category, the data fingerprint unchanged.
//   - Marker regression: a deeply nested payload's keys/values carry a marker -- the error
//     response's serialization doesn't contain the marker.
//   - Neutralization verification: calling the story layer directly (bypassing writeTools.ts's
//     sanitization layer) proves the deep-nesting/circular-reference cases really would go wrong
//     without this sanitization layer (deep nesting makes `updateStoryStructure()` reject with an
//     uncaught exception directly; a circular reference makes `updateStoryStructure()` succeed
//     silently, and then `collectReferencedChapterSlugs()` -- the function `update_page_text`/
//     `inspect_story`/`get_story_readiness` actually call -- recurses into the persisted circular
//     structure and blows the stack).
//
// Category: WebMCP tool-surface logic, filenames ending in .webmcp.test.ts go into test:webmcp
// (see README.md).
import { describe, expect, it } from "vitest";
import { DomWebMcpFacade } from "../facade.ts";
import { createFakeWebMcpDocument, FakeModelContext } from "../../testing/fakeModelContext.ts";
import { MemoryWorkspaceStorage } from "../../testing/fakes.ts";
import { collectReferencedChapterSlugs, createMinimalStory, DEFAULT_LANG, readStory, updateStoryStructure } from "../../story/index.ts";
import type { WorkspaceStoragePort } from "../../ports.ts";
import { createStoryUiController } from "../../ui/controller.ts";
import { createFocusController } from "../../story/focus.ts";
import type { StorySpec } from "../../contract/types.ts";
import {
  createWriteTools,
  MAX_SPEC_DEPTH,
  type CreateStoryToolResult,
  type SetPageImageToolResult,
  type UpdatePageTextToolResult,
  type UpdateStoryStructureToolResult,
} from "./writeTools.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBase64(): string {
  const bytes = new Uint8Array([...PNG_SIGNATURE, ...new Array(32).fill(0xab)]);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Builds a plain nested object (`{ child: { child: { ... leaf } } }`) `depth` levels deep -- pure
 * JSON, no circular reference at all, used on its own to test "deep nesting" as a trigger path
 * that's independent from a circular reference (see the "Spec input sanitization + execute-wide
 * try/catch" note in the header of ./writeTools.ts -- to `exceedsMaxDepth()`, the two look like the same
 * "over the depth cap," but the actual mechanism that triggers a downstream crash differs between
 * them: deep nesting blows `stringifyYaml()`'s own recursive stack; a circular reference lets
 * `stringifyYaml()` get away with it via an anchor, leaving the blowup for a later read). */
function buildDeepObject(depth: number, leaf: Record<string, unknown> = { leaf: true }): unknown {
  let obj: unknown = leaf;
  for (let i = 0; i < depth; i++) obj = { child: obj };
  return obj;
}

async function setup(storage: WorkspaceStoragePort = new MemoryWorkspaceStorage()) {
  await storage.open();
  const modelContext = new FakeModelContext();
  const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
  const registration = facade.registerTools(createWriteTools({ storage }));
  await registration.ready;
  return { storage, modelContext, registration };
}

/** The workspace's "data fingerprint" -- the full list() listing (path/kind/byteLength, sorted).
 * When a failure case asserts "the workspace is unchanged," comparing this fingerprint is more
 * complete than comparing file by file, and doesn't require enumerating which files should
 * exist. */
async function fingerprint(storage: WorkspaceStoragePort) {
  const snapshot = await storage.list();
  return { revision: snapshot.revision, entries: [...snapshot.entries].sort((a, b) => a.path.localeCompare(b.path)) };
}

describe("createWriteTools — registration & schema", () => {
  it("registers exactly the four write tools, each writable (readOnlyHint: false) with an honest inputSchema", async () => {
    const { modelContext } = await setup();

    const names = ["create_story", "set_page_image", "update_page_text", "update_story_structure"];
    expect(modelContext.registeredNames()).toEqual(names);
    for (const name of names) {
      const tool = modelContext.getRegisteredTool(name);
      expect(tool).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(false);
      expect(tool?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool?.description.length).toBeGreaterThan(0);
    }

    const createSchema = modelContext.getRegisteredTool("create_story")?.inputSchema as { required: string[] };
    expect(createSchema.required).toEqual(["slug", "title"]);
    const structureSchema = modelContext.getRegisteredTool("update_story_structure")?.inputSchema as { required: string[] };
    expect(structureSchema.required).toEqual(["expectedRevision", "spec"]);
    const pageTextSchema = modelContext.getRegisteredTool("update_page_text")?.inputSchema as { required: string[] };
    expect(pageTextSchema.required).toEqual(["expectedRevision", "chapterSlug", "lang", "text"]);
    const imageSchema = modelContext.getRegisteredTool("set_page_image")?.inputSchema as { required: string[] };
    expect(imageSchema.required).toEqual(["expectedRevision", "storySlug", "chapterSlug", "imageBase64"]);
  });

  it("onMutated fires exactly once per successful write, and not at all on a rejected write", async () => {
    const storage = new MemoryWorkspaceStorage();
    await storage.open();
    let mutatedCount = 0;
    const modelContext = new FakeModelContext();
    const facade = new DomWebMcpFacade(createFakeWebMcpDocument(modelContext));
    const registration = facade.registerTools(createWriteTools({ storage, onMutated: () => { mutatedCount += 1; } }));
    await registration.ready;

    const created = (await modelContext.invoke("create_story", { slug: "mutated-story", title: "Was there a notification" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    expect(mutatedCount).toBe(1);

    // A failed call (the workspace is already non-empty, so create_story must be rejected)
    // should not trigger onMutated.
    await modelContext.invoke("create_story", { slug: "mutated-story-2", title: "The second time" });
    expect(mutatedCount).toBe(1);

    if (!created.ok) return;
    const setImage = (await modelContext.invoke("set_page_image", {
      expectedRevision: created.revision,
      storySlug: "mutated-story",
      chapterSlug: "page-01",
      imageBase64: pngBase64(),
      mimeType: "image/png",
    })) as SetPageImageToolResult;
    expect(setImage.ok).toBe(true);
    expect(mutatedCount).toBe(2);
  });
});

describe("set_page_image — happy path, and leak regression", () => {
  it("agent can create a story and directly supply a page image; success reply stays minimal ({ ok, revision } only)", async () => {
    const { storage, modelContext } = await setup();

    const created = (await modelContext.invoke("create_story", { slug: "image-story", title: "An illustrated story" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = (await modelContext.invoke("set_page_image", {
      expectedRevision: created.revision,
      storySlug: "image-story",
      chapterSlug: "page-01",
      imageBase64: pngBase64(),
      mimeType: "image/png",
    })) as SetPageImageToolResult;
    expect(result).toEqual({ ok: true, revision: created.revision + 1 });

    const snapshot = await storage.list();
    expect(snapshot.entries.some((e) => e.path === "media/page-01.png")).toBe(true);
  });

  it("chapter-not-found does not echo the chapterSlug the caller sent — only the known slug list", async () => {
    const { modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "leak-check-story", title: "Leak check" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const marker = "MARKER-9f2c7d1e-should-not-leak";
    const result = (await modelContext.invoke("set_page_image", {
      expectedRevision: created.revision,
      storySlug: "leak-check-story",
      chapterSlug: marker,
      imageBase64: pngBase64(),
      mimeType: "image/png",
    })) as SetPageImageToolResult;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(result.error).toEqual({ type: "chapter-not-found", knownChapterSlugs: expect.arrayContaining(["page-01"]) });
  });
});

describe("set_page_image — malformed input at every layer (a schema violation, a structured throw, not ok:false)", () => {
  it("rejects a non-object input, and each malformed top-level field, without mutating the workspace", async () => {
    const { storage, modelContext } = await setup();
    const native = modelContext.getRegisteredTool("set_page_image");
    expect(native).toBeDefined();
    const before = await fingerprint(storage);

    for (const badInput of [undefined, null, "a string", 42, []]) {
      await expect(native!.execute(badInput)).rejects.toThrow("set_page_image: input does not match schema");
    }

    const validBase = { expectedRevision: 0, storySlug: "s", chapterSlug: "page-01", imageBase64: pngBase64() };
    await expect(native!.execute({ ...validBase, expectedRevision: "0" })).rejects.toThrow("set_page_image");
    await expect(native!.execute({ ...validBase, expectedRevision: -1 })).rejects.toThrow("set_page_image");
    await expect(native!.execute({ ...validBase, expectedRevision: 1.5 })).rejects.toThrow("set_page_image");
    await expect(native!.execute({ ...validBase, storySlug: 123 })).rejects.toThrow("set_page_image");
    await expect(native!.execute({ ...validBase, chapterSlug: null })).rejects.toThrow("set_page_image");
    await expect(native!.execute({ ...validBase, imageBase64: ["not", "a", "string"] })).rejects.toThrow("set_page_image");
    await expect(native!.execute({ ...validBase, mimeType: 7 })).rejects.toThrow("set_page_image");
    // Missing a required field — none of expectedRevision/storySlug/chapterSlug/imageBase64 can
    // be omitted.
    for (const field of ["expectedRevision", "storySlug", "chapterSlug", "imageBase64"] as const) {
      const { [field]: _omit, ...rest } = validBase;
      await expect(native!.execute(rest)).rejects.toThrow("set_page_image");
    }

    expect(await fingerprint(storage)).toEqual(before);
  });
});

describe("create_story → update_page_text → update_story_structure — full chain, and cross-layer consistency", () => {
  it("agent can create a minimal story, edit its page text, and edit its structure — success replies stay minimal ({ ok, revision } only)", async () => {
    const { storage, modelContext } = await setup();

    const created = (await modelContext.invoke("create_story", { slug: "agent-story", title: "A story written by an agent" })) as CreateStoryToolResult;
    expect(created).toEqual({ ok: true, revision: expect.any(Number) });
    if (!created.ok) return;

    // Read the current story to get chapterSlug/spec -- this is something the agent would do
    // itself (call inspect_story; here we use the equivalent readStory() directly, since
    // inspect_story itself was already covered by the 3.2 acceptance tests) -- not the focus of
    // this test, which is the write tools themselves.
    const before = await readStory(storage);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const chapterSlug = before.spec.start;

    // Uses DEFAULT_LANG (not a literal "en") so this write lands in the same content file
    // createMinimalStory() already created for this chapterSlug -- this test also reads the
    // result back through the UI controller below, and that cross-layer check needs a single,
    // unambiguous content file per chapterSlug, not a second language variant sitting alongside
    // the original.
    const textResult = (await modelContext.invoke("update_page_text", {
      expectedRevision: created.revision,
      chapterSlug,
      lang: DEFAULT_LANG,
      text: "New text written by the agent, replacing the initial text from when the minimal story was created.",
    })) as UpdatePageTextToolResult;
    expect(textResult).toEqual({ ok: true, revision: created.revision + 1 });
    if (!textResult.ok) return;

    const afterText = await readStory(storage);
    expect(afterText.ok).toBe(true);
    if (!afterText.ok) return;

    const structureResult = (await modelContext.invoke("update_story_structure", {
      expectedRevision: textResult.revision,
      spec: afterText.spec,
    })) as UpdateStoryStructureToolResult;
    expect(structureResult).toEqual({ ok: true, revision: textResult.revision + 1 });
    if (!structureResult.ok) return;

    // A success response always has only { ok, revision } -- it never echoes title/text/spec
    // (clause B).
    expect(Object.keys(structureResult).sort()).toEqual(["ok", "revision"]);
    expect(Object.keys(textResult).sort()).toEqual(["ok", "revision"]);
    expect(Object.keys(created).sort()).toEqual(["ok", "revision"]);

    const finalSnapshot = await readStory(storage);
    expect(finalSnapshot.ok).toBe(true);
    if (!finalSnapshot.ok) return;
    expect(finalSnapshot.revision).toBe(structureResult.revision);
    expect(finalSnapshot.spec.nodes[chapterSlug]).toEqual(afterText.spec.nodes[chapterSlug]);

    const contentFile = await storage.readFile(`content/${chapterSlug}.${DEFAULT_LANG}.txt`);
    expect(contentFile?.kind === "text" ? contentFile.text : undefined).toBe(
      "New text written by the agent, replacing the initial text from when the minimal story was created.",
    );

    // ---- The UI hydrates to the same result after a tool call (per the epic's acceptance criteria: cross-layer integration) ----
    const focus = createFocusController(storage);
    const ui = createStoryUiController({ storage, focus, viewerOrigin: "https://example.test", relayUrl: undefined });
    await ui.hydrate();
    const uiState = ui.getState();
    expect(uiState.view).toBe("editor");
    if (uiState.view !== "editor") return;
    expect(uiState.revision).toBe(structureResult.revision);
    expect(Object.keys(uiState.spec.nodes)).toContain(chapterSlug);
    ui.openMapNode(chapterSlug);
    const opened = ui.getState();
    expect(opened.view).toBe("editor");
    if (opened.view !== "editor") return;
    expect(opened.pagePreviews.get(chapterSlug)).toBe(
      "New text written by the agent, replacing the initial text from when the minimal story was created.",
    );
  });
});

describe("create_story — rejected on a non-empty workspace", () => {
  it("rejects creating a second story when the workspace already has one, and leaves the workspace untouched", async () => {
    const { storage, modelContext } = await setup();

    const first = (await modelContext.invoke("create_story", { slug: "first-story", title: "The first one" })) as CreateStoryToolResult;
    expect(first.ok).toBe(true);
    const fingerprintBefore = await fingerprint(storage);

    const second = (await modelContext.invoke("create_story", { slug: "second-story", title: "The second one" })) as CreateStoryToolResult;
    expect(second).toEqual({ ok: false, error: { type: "workspace-not-empty", entryCount: expect.any(Number) } });

    expect(await fingerprint(storage)).toEqual(fingerprintBefore);
  });
});

describe("update_page_text — failure paths: the data fingerprint is unchanged", () => {
  it("stale expectedRevision fails as a recognizable revision-conflict carrying the current actualRevision, and does not mutate the workspace", async () => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "conflict-story", title: "A conflict test" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const spec = await readStory(storage);
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;
    const chapterSlug = spec.spec.start;

    // First write successfully once with the real expectedRevision, advancing the workspace to R+1.
    const firstWrite = (await modelContext.invoke("update_page_text", {
      expectedRevision: created.revision,
      chapterSlug,
      lang: "en",
      text: "The first successful write.",
    })) as UpdatePageTextToolResult;
    expect(firstWrite.ok).toBe(true);
    if (!firstWrite.ok) return;
    const fingerprintAfterFirstWrite = await fingerprint(storage);

    // Send a second write with the same (now stale) expectedRevision -- it must be rejected, and
    // recognizable as a revision-conflict carrying the current actualRevision (per the original
    // task wording: "report the latest revision on conflict so the agent can re-read").
    const staleWrite = (await modelContext.invoke("update_page_text", {
      expectedRevision: created.revision,
      chapterSlug,
      lang: "en",
      text: "This write should not land.",
    })) as UpdatePageTextToolResult;
    expect(staleWrite).toEqual({
      ok: false,
      error: { type: "mutation-rejected", error: { type: "revision-conflict", expectedRevision: created.revision, actualRevision: firstWrite.revision } },
    });

    expect(await fingerprint(storage)).toEqual(fingerprintAfterFirstWrite);
    const content = await storage.readFile(`content/${chapterSlug}.en.txt`);
    expect(content?.kind === "text" ? content.text : undefined).toBe("The first successful write.");
  });

  it("an unknown chapterSlug fails as chapter-not-found with the known slug list, and does not mutate the workspace", async () => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "unknown-page-story", title: "An unknown-page test" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await fingerprint(storage);

    const result = (await modelContext.invoke("update_page_text", {
      expectedRevision: created.revision,
      chapterSlug: "not-a-real-chapter",
      lang: "en",
      text: "This write should not land.",
    })) as UpdatePageTextToolResult;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ type: "chapter-not-found", knownChapterSlugs: expect.arrayContaining(["page-01"]) });

    expect(await fingerprint(storage)).toEqual(before);
  });
});

describe("update_story_structure — a broken StorySpec is rejected, the data fingerprint is unchanged", () => {
  it("rejects a spec with a validate()-error diagnostic (dangling next target) and leaves story.yaml untouched", async () => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "bad-spec-story", title: "A broken-spec test" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await readStory(storage);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const fingerprintBefore = await fingerprint(storage);

    const badSpec = {
      ...before.spec,
      nodes: {
        ...before.spec.nodes,
        [before.spec.start]: { type: undefined, next: "does-not-exist", ending: undefined },
      },
    };
    const result = (await modelContext.invoke("update_story_structure", {
      expectedRevision: created.revision,
      spec: badSpec,
    })) as UpdateStoryStructureToolResult;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("invalid-story-spec");
    if (result.error.type !== "invalid-story-spec") return;
    expect(result.error.diagnostics.errorCount).toBeGreaterThan(0);

    expect(await fingerprint(storage)).toEqual(fingerprintBefore);
  });

  it.each(["inputs", "state", "outcomes", "x-gamified"]) ("rejects removed field %s without changing revision", async (field) => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "closed-contract", title: "Closed contract" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await fingerprint(storage);
    const current = await readStory(storage);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    const result = (await modelContext.invoke("update_story_structure", {
      expectedRevision: created.revision,
      spec: { ...current.spec, [field]: {} },
    })) as UpdateStoryStructureToolResult;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("invalid-story-spec");
    expect(await fingerprint(storage)).toEqual(before);
  });

  it.each([
    ["malformed content ref", (spec: any) => ({ ...spec, nodes: { ...spec.nodes, [spec.start]: { ...spec.nodes[spec.start], content: { $ref: "nope" } } } })],
    ["cross-story content ref", (spec: any) => ({ ...spec, nodes: { ...spec.nodes, [spec.start]: { ...spec.nodes[spec.start], content: { $ref: "content://other/chapters/page-01#fragments/text" } } } })],
    ["empty nodes", (spec: any) => ({ ...spec, start: "", nodes: {} })],
  ])("rejects %s without changing revision", async (_name, makeSpec) => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "closed-refs", title: "Closed references" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await fingerprint(storage);
    const current = await readStory(storage);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    const result = (await modelContext.invoke("update_story_structure", {
      expectedRevision: created.revision,
      spec: makeSpec(current.spec),
    })) as UpdateStoryStructureToolResult;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("invalid-story-spec");
    expect(await fingerprint(storage)).toEqual(before);
  });
});

describe("leak regression (landing the lesson from the 3.2 three-round review, see clause B in the header of ./writeTools.ts)", () => {
  const MARKER = "UNIQUE-LEAK-MARKER-9f3c";

  it("case 1: a free-text string carrying a marker is placed in a field that should hold { $ref } (validate()'s diagnostic.message would carry the original text) — update_story_structure's error response does not contain the marker", async () => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "leak-spec-story", title: "Leak test one" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await readStory(storage);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    // The content field should be { $ref: ... }; here we deliberately put in a bare string
    // (carrying a marker) instead -- checkRefField() embeds this raw value unchanged into
    // diagnostic.message.
    const badSpec = {
      ...before.spec,
      nodes: { ...before.spec.nodes, [before.spec.start]: { ...before.spec.nodes[before.spec.start], content: MARKER } },
    };
    const result = (await modelContext.invoke("update_story_structure", {
      expectedRevision: created.revision,
      spec: badSpec,
    })) as UpdateStoryStructureToolResult;

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it("case 2a: the unknown chapterSlug parameter itself (chapter-not-found) — the error response does not echo the chapterSlug value the caller passed in", async () => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "leak-chapter-story", title: "Leak test two a" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const uniqueUnknownSlug = "marker-9f3c-does-not-exist";
    const result = (await modelContext.invoke("update_page_text", {
      expectedRevision: created.revision,
      chapterSlug: uniqueUnknownSlug,
      lang: "en",
      text: "Should not land.",
    })) as UpdatePageTextToolResult;

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(uniqueUnknownSlug);
  });

  it("case 2b: an unknown chapterSlug triggers the workspace path allowlist's hidden-segment rejection (reservedShapeReason embeds the whole path segment unchanged into reason) — the error response does not contain the marker", async () => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "leak-path-story", title: "Leak test two b" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await fingerprint(storage);

    // chapterSlug starts with "." -- the resulting path "content/.{marker}.en.txt" triggers the
    // hidden-segment branch of ../../workspace/paths.ts's reservedShapeReason(), which used to
    // embed the whole path segment (including this marker) into invalid-path.reason.
    const result = (await modelContext.invoke("update_page_text", {
      expectedRevision: created.revision,
      chapterSlug: `.${MARKER}`,
      lang: "en",
      text: "Should not land.",
    })) as UpdatePageTextToolResult;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ type: "invalid-path" });
    expect(JSON.stringify(result)).not.toContain(MARKER);

    expect(await fingerprint(storage)).toEqual(before);
  });

  it("case 3: over-length text triggers size-exceeded — the error response contains no marker and no content clue beyond the byte count, the workspace is unchanged", async () => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "leak-size-story", title: "Leak test three" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await readStory(storage);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const chapterSlug = before.spec.start;
    const fingerprintBefore = await fingerprint(storage);

    const oversizedText = `${MARKER}${"A".repeat(2 * 1024 * 1024 + 10)}`;
    const result = (await modelContext.invoke("update_page_text", {
      expectedRevision: created.revision,
      chapterSlug,
      lang: "en",
      text: oversizedText,
    })) as UpdatePageTextToolResult;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ type: "mutation-rejected", error: { type: "size-exceeded" } });
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(JSON.stringify(result).length).toBeLessThan(500); // no full text -- the response itself should be short

    expect(await fingerprint(storage)).toEqual(fingerprintBefore);
  });
});

describe("spec-input-sanitization regression tests (see the header of ./writeTools.ts)", () => {
  it("nodes.<id> = null (legal JSON, validate() throws an uncaught exception accessing a null property) — returns internal-error, the data fingerprint is unchanged, inspect_story reads still work normally", async () => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "null-node-regression", title: "Regression: a null node" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await readStory(storage);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const fingerprintBefore = await fingerprint(storage);

    const badSpec = { ...before.spec, nodes: { ...before.spec.nodes, [before.spec.start]: null } };
    const result = (await modelContext.invoke("update_story_structure", {
      expectedRevision: created.revision,
      spec: badSpec,
    })) as UpdateStoryStructureToolResult;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("invalid-story-spec");
    expect(await fingerprint(storage)).toEqual(fingerprintBefore);

    // The equivalent read to inspect_story -- the workspace wasn't broken by this failed call,
    // the original story can still be read and is identical to before the failed attempt.
    const after = await readStory(storage);
    expect(after).toEqual(before);
  });

  it("choices.<key> = null (legal JSON, the same class of null-property-access exception) — returns internal-error, the data fingerprint is unchanged, inspect_story reads still work normally", async () => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "null-choice-regression", title: "Regression: a null choice" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await readStory(storage);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const fingerprintBefore = await fingerprint(storage);

    const badSpec = {
      ...before.spec,
      nodes: { ...before.spec.nodes, "extra-node": { choices: { c1: null } } },
    };
    const result = (await modelContext.invoke("update_story_structure", {
      expectedRevision: created.revision,
      spec: badSpec,
    })) as UpdateStoryStructureToolResult;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe("invalid-story-spec");
    expect(await fingerprint(storage)).toEqual(fingerprintBefore);
    expect(await readStory(storage)).toEqual(before);
  });

  it("a deeply nested spec (plain JSON, no cycle needed, depth far past MAX_SPEC_DEPTH) — returns invalid-spec-shape, the data fingerprint is unchanged, inspect_story reads still work normally", async () => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "deep-nesting-regression", title: "Regression: deep nesting" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await readStory(storage);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const fingerprintBefore = await fingerprint(storage);

    const deepSpec = {
      ...before.spec,
      nodes: {
        ...before.spec.nodes,
        [before.spec.start]: { ...before.spec.nodes[before.spec.start], "x-deep-test": buildDeepObject(MAX_SPEC_DEPTH + 50) },
      },
    };
    const result = (await modelContext.invoke("update_story_structure", {
      expectedRevision: created.revision,
      spec: deepSpec,
    })) as UpdateStoryStructureToolResult;

    expect(result).toEqual({ ok: false, error: { type: "invalid-spec-shape" } });
    expect(await fingerprint(storage)).toEqual(fingerprintBefore);
    expect(await readStory(storage)).toEqual(before);
  });

  it("a circular-reference object (a hand-built JS object; the yaml package tolerates the cycle with an anchor, no throw) — returns invalid-spec-shape, the data fingerprint is unchanged, inspect_story reads still work normally", async () => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "circular-reference-regression", title: "Regression: a circular reference" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await readStory(storage);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const fingerprintBefore = await fingerprint(storage);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- hand-building a genuinely
    // circular object; the type system simply can't express self-reference, so `any` is the only
    // way to write this test.
    const circular: any = { child: null };
    circular.child = circular;
    const circularSpec = {
      ...before.spec,
      nodes: {
        ...before.spec.nodes,
        [before.spec.start]: { ...before.spec.nodes[before.spec.start], "x-circular-test": circular },
      },
    };
    const result = (await modelContext.invoke("update_story_structure", {
      expectedRevision: created.revision,
      spec: circularSpec,
    })) as UpdateStoryStructureToolResult;

    expect(result).toEqual({ ok: false, error: { type: "invalid-spec-shape" } });
    expect(await fingerprint(storage)).toEqual(fingerprintBefore);
    expect(await readStory(storage)).toEqual(before);
  });

  it("marker regression: a deeply nested payload's keys and values both carry a marker — the invalid-spec-shape response (a fixed shape, no fields) does not contain the marker", async () => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "deep-nesting-marker-regression", title: "Regression: a deep-nesting marker" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await readStory(storage);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const MARKER = "UNIQUE-DEEP-PAYLOAD-MARKER-7ac2";
    const deepWithMarker = buildDeepObject(MAX_SPEC_DEPTH + 50, { [MARKER]: MARKER });
    const spec = {
      ...before.spec,
      nodes: {
        ...before.spec.nodes,
        [before.spec.start]: { ...before.spec.nodes[before.spec.start], "x-deep-test": deepWithMarker },
      },
    };
    const result = (await modelContext.invoke("update_story_structure", {
      expectedRevision: created.revision,
      spec,
    })) as UpdateStoryStructureToolResult;

    expect(result).toEqual({ ok: false, error: { type: "invalid-spec-shape" } });
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it("review P2 regression: a throwing enumerable getter at the spec's top level — returns invalid-spec-shape, does not reject, the getter's message does not escape", async () => {
    const { storage, modelContext } = await setup();
    const created = (await modelContext.invoke("create_story", { slug: "getter-probe", title: "Getter regression" })) as CreateStoryToolResult;
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const evil: Record<string, unknown> = { specVersion: "storymaker/v1alpha1" };
    Object.defineProperty(evil, "boobyTrap", {
      enumerable: true,
      get() {
        throw new Error("UNIQUE_GETTER_MARKER_P2");
      },
    });

    // Must not reject (rejecting would let the getter's own message escape to the host) -- it
    // must converge to a safe DTO.
    const result = (await modelContext.invoke("update_story_structure", {
      expectedRevision: created.revision,
      spec: evil,
    })) as UpdateStoryStructureToolResult;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("invalid-spec-shape");
    expect(JSON.stringify(result)).not.toContain("UNIQUE_GETTER_MARKER_P2");
  });

  describe("neutralization verification (proof that removing the sanitization layer turns this red — calling the story layer directly, bypassing writeTools.ts's sanitization layer)", () => {
    it("deep nesting: calling the story layer's updateStoryStructure() directly, without sanitization, really does make stringifyYaml() throw an uncaught exception", async () => {
      const storage = new MemoryWorkspaceStorage();
      await storage.open();
      const seed = await createMinimalStory(storage, { slug: "neutral-deep", title: "Neutralization verification: deep nesting" });
      expect(seed.ok).toBe(true);
      if (!seed.ok) return;
      const before = await readStory(storage);
      expect(before.ok).toBe(true);
      if (!before.ok) return;

      // Deliberately use a depth (2000) far past MAX_SPEC_DEPTH (already reproduced in the header
      // of writeTools.ts as a RangeError with yaml@2.9.0) -- this bypasses writeTools.ts's
      // sanitization layer and calls the story layer itself directly.
      const deepSpec = {
        ...before.spec,
        nodes: { ...before.spec.nodes, [before.spec.start]: { ...before.spec.nodes[before.spec.start], "x-deep-test": buildDeepObject(2000) } },
      };

      const result = await updateStoryStructure(storage, { expectedRevision: seed.revision, spec: deepSpec as unknown as StorySpec });
      expect(result.ok).toBe(false);
    });

    it("circular reference: calling the story layer's updateStoryStructure() directly, without sanitization, actually succeeds silently (the dangerous core of the bug — the write side never throws)", async () => {
      const storage = new MemoryWorkspaceStorage();
      await storage.open();
      const seed = await createMinimalStory(storage, { slug: "neutral-circular-write", title: "Neutralization verification: a circular write" });
      expect(seed.ok).toBe(true);
      if (!seed.ok) return;
      const before = await readStory(storage);
      expect(before.ok).toBe(true);
      if (!before.ok) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const circular: any = { child: null };
      circular.child = circular;
      const circularSpec = {
        ...before.spec,
        nodes: { ...before.spec.nodes, [before.spec.start]: { ...before.spec.nodes[before.spec.start], "x-circular-test": circular } },
      };

      const result = await updateStoryStructure(storage, { expectedRevision: seed.revision, spec: circularSpec as unknown as StorySpec });
      expect(result.ok).toBe(false);
    });

    it("circular reference: collectReferencedChapterSlugs() (the function update_page_text/inspect_story/get_story_readiness actually call) genuinely recurses into a circular structure until the stack overflows", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const circular: any = { child: null };
      circular.child = circular;
      const spec = {
        specVersion: "storymaker/v1alpha1",
        kind: "Story",
        metadata: { slug: "neutral-circular-read" },
        start: "n",
        nodes: {
          n: {
            type: "ending",
            content: { $ref: "content://neutral-circular-read/chapters/n#fragments/text" },
            ending: { endingId: "n-ending", endingType: "good" },
            "x-circular-test": circular,
          },
        },
      };

      expect(() => collectReferencedChapterSlugs(spec as unknown as StorySpec)).not.toThrow();
    });
  });
});

describe("real-browser regression: the host calls the real write tool directly, without options", () => {
  // Same regression as the one at the end of readonlyTools.webmcp.test.ts: a real host (the
  // ChatGPT desktop app's built-in browser) calls execute without options/signal. This
  // deliberately doesn't go through FakeModelContext.invoke() (which always takes the forgiving
  // path of synthesizing a signal) -- it calls the mounted native create_story directly, in the
  // shape the real host actually uses, proving the entire real write path (signal check -> input
  // validation -> OCC write) still works completely under the host's unusual shape, not just that
  // the facade's conversion function itself is correct.
  it("create_story called as execute(input) (no options) can write successfully; execute(undefined) fails closed with a structured error", async () => {
    const { storage, modelContext } = await setup();

    const native = modelContext.getRegisteredTool("create_story");
    expect(native).toBeDefined();

    const created = (await native!.execute({ slug: "host-shape-story", title: "A host-shaped story" })) as CreateStoryToolResult;
    expect(created).toEqual({ ok: true, revision: expect.any(Number) });

    // Not even an input at all: this must fail closed -- per this file's existing convention, a
    // schema violation is a structured throw (the message is a program constant, meeting the exit
    // criteria), never a native TypeError, and the workspace must be unchanged.
    const before = await fingerprint(storage);
    await expect(native!.execute(undefined)).rejects.toThrow("create_story: input does not match schema");
    expect(await fingerprint(storage)).toEqual(before);
  });
});
