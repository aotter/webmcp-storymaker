// Tests for ./setPageImage.ts --
// the write path for the agent supplying images directly (no manual
// approval). Covers six cases: happy path
// (with/without mimeType), bad magic bytes, oversized, wrong revision,
// malformed input at each layer (schema validation at the webmcp boundary is
// left to ../webmcp/tools/writeTools.webmcp.test.ts; this file tests the
// input semantics this layer itself rejects), and overwriting an existing
// page image (including deleting the old file when its extension differs).
import { describe, expect, it, vi } from "vitest";
import { MemoryWorkspaceStorage } from "../testing/fakes.ts";
import { createMinimalStory, readStory } from "../story/index.ts";
import { setPageImage, MAX_BASE64_LENGTH, SET_PAGE_IMAGE_MAX_BYTES } from "./setPageImage.ts";
import type { WorkspaceStoragePort } from "../ports.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function bytesOf(...groups: (number[] | number)[]): Uint8Array {
  const flat: number[] = [];
  for (const g of groups) {
    if (Array.isArray(g)) flat.push(...g);
    else flat.push(g);
  }
  return new Uint8Array(flat);
}

function fillerBytes(n: number): number[] {
  return new Array(n).fill(0xab);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const VALID_PNG = bytesOf(PNG_SIGNATURE, fillerBytes(32));
const VALID_JPEG = bytesOf(JPEG_SIGNATURE, fillerBytes(32));

async function setupStoryWith(storage: WorkspaceStoragePort = new MemoryWorkspaceStorage()) {
  await storage.open();
  const created = await createMinimalStory(storage, { slug: "agent-story", title: "A Story Written by an Agent" });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("setup failed");
  const story = await readStory(storage);
  expect(story.ok).toBe(true);
  if (!story.ok) throw new Error("setup failed");
  return { storage, storySlug: story.spec.metadata.slug, chapterSlug: story.spec.start, revision: created.revision };
}

describe("setPageImage — happy path", () => {
  it("writes media/<chapterSlug>.png and a media.json entry when mimeType is given", async () => {
    const { storage, storySlug, chapterSlug, revision } = await setupStoryWith();

    const result = await setPageImage(storage, {
      expectedRevision: revision,
      storySlug,
      chapterSlug,
      imageBase64: toBase64(VALID_PNG),
      mimeType: "image/png",
    });
    expect(result).toEqual({ ok: true, revision: revision + 1 });

    const snapshot = await storage.list();
    const mediaEntry = snapshot.entries.find((e) => e.path === `media/${chapterSlug}.png`);
    expect(mediaEntry).toMatchObject({ kind: "blob", byteLength: VALID_PNG.length });

    const mediaJsonFile = await storage.readFile("media.json");
    expect(mediaJsonFile?.kind).toBe("text");
    const mediaJson = JSON.parse((mediaJsonFile as { text: string }).text);
    expect(mediaJson[chapterSlug]).toEqual({ file: `${chapterSlug}.png` });
  });

  it("sniffs the extension from magic bytes when mimeType is omitted", async () => {
    const { storage, storySlug, chapterSlug, revision } = await setupStoryWith();

    const result = await setPageImage(storage, {
      expectedRevision: revision,
      storySlug,
      chapterSlug,
      imageBase64: toBase64(VALID_JPEG),
    });
    expect(result).toEqual({ ok: true, revision: revision + 1 });

    const snapshot = await storage.list();
    expect(snapshot.entries.some((e) => e.path === `media/${chapterSlug}.jpg`)).toBe(true);
  });
});

describe("setPageImage — bad magic bytes", () => {
  it("rejects content whose magic bytes don't match the claimed mimeType, and leaves the workspace untouched", async () => {
    const { storage, storySlug, chapterSlug, revision } = await setupStoryWith();
    const textDisguisedAsPng = bytesOf(fillerBytes(40)); // no signature of any known format

    const result = await setPageImage(storage, {
      expectedRevision: revision,
      storySlug,
      chapterSlug,
      imageBase64: toBase64(textDisguisedAsPng),
      mimeType: "image/png",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("invalid-image");

    const snapshot = await storage.list();
    expect(snapshot.revision).toBe(revision);
    expect(snapshot.entries.some((e) => e.path.startsWith("media/"))).toBe(false);
  });

  it("rejects when sniffing (no mimeType) can't match any of the supported formats", async () => {
    const { storage, storySlug, chapterSlug, revision } = await setupStoryWith();

    const result = await setPageImage(storage, {
      expectedRevision: revision,
      storySlug,
      chapterSlug,
      imageBase64: toBase64(bytesOf(fillerBytes(40))),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("invalid-image");
  });
});

describe("setPageImage — oversized", () => {
  it("rejects an image larger than SET_PAGE_IMAGE_MAX_BYTES before doing any workspace I/O", async () => {
    const { storage, storySlug, chapterSlug, revision } = await setupStoryWith();
    // Build the oversized array directly with Uint8Array.set() -- bytesOf()/spread
    // at this array size would hit the JS engine's "max arguments per function
    // call" limit (RangeError: Maximum call stack size exceeded).
    const oversized = new Uint8Array(PNG_SIGNATURE.length + SET_PAGE_IMAGE_MAX_BYTES);
    oversized.set(PNG_SIGNATURE, 0);
    oversized.fill(0xab, PNG_SIGNATURE.length);

    const result = await setPageImage(storage, {
      expectedRevision: revision,
      storySlug,
      chapterSlug,
      imageBase64: toBase64(oversized),
      mimeType: "image/png",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("image-too-large");
    if (result.error.type === "image-too-large") {
      expect(result.error.maxBytes).toBe(SET_PAGE_IMAGE_MAX_BYTES);
      // After the acceptance fix, this case is now blocked at the pre-decode
      // string-length check (see the next test) -- so byteLength is an
      // estimate derived from the encoded string length, not an actual
      // decode result, and no longer equals oversized.length exactly; this
      // only checks it's still a positive number honestly reflecting
      // "too large", in the neighborhood of the real byte count.
      expect(result.error.byteLength).toBeGreaterThan(SET_PAGE_IMAGE_MAX_BYTES);
    }

    const snapshot = await storage.list();
    expect(snapshot.revision).toBe(revision);
  });

  it("acceptance fix: rejects an over-length base64 string without ever decoding it (atob() is never called)", async () => {
    const { storage, storySlug, chapterSlug, revision } = await setupStoryWith();
    const atobSpy = vi.spyOn(globalThis, "atob");

    // Build a string guaranteed to exceed MAX_BASE64_LENGTH -- using
    // "A".repeat() rather than first building a genuinely huge Uint8Array and
    // encoding it (that would itself spend the time/memory this fix is meant
    // to avoid). The string length alone already exceeds the threshold, so
    // rejection is guaranteed regardless of content, and can be decided
    // without ever actually decoding.
    const hugeBase64 = "A".repeat(MAX_BASE64_LENGTH + 4);

    const start = performance.now();
    const result = await setPageImage(storage, {
      expectedRevision: revision,
      storySlug,
      chapterSlug,
      imageBase64: hugeBase64,
      mimeType: "image/png",
    });
    const elapsedMs = performance.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      type: "image-too-large",
      byteLength: Math.floor((hugeBase64.length * 3) / 4),
      maxBytes: SET_PAGE_IMAGE_MAX_BYTES,
    });

    // Deterministic proof, not a timing guess: the only decode API
    // decodeBase64() calls internally is the global atob() -- the spy shows
    // it was never called, proving this rejection happens before atob(), not
    // just "it happened to finish quickly anyway".
    expect(atobSpy).not.toHaveBeenCalled();
    atobSpy.mockRestore();

    // "Returns fast" serves as a second piece of corroborating evidence (not
    // the sole proof) -- even if some environment's atob() spy misfires, a
    // string well over 6MB, if it were actually decoded, couldn't finish in
    // a few tens of milliseconds.
    expect(elapsedMs).toBeLessThan(200);

    const snapshot = await storage.list();
    expect(snapshot.revision).toBe(revision);
  });

  it("typeof imageBase64 !== \"string\" is rejected before the length check", async () => {
    const { storage, storySlug, chapterSlug, revision } = await setupStoryWith();

    const result = await setPageImage(storage, {
      expectedRevision: revision,
      storySlug,
      chapterSlug,
      // @ts-expect-error — deliberately feeding a non-string value, proving the
      // type check comes before the length check and doesn't blow up with an
      // uncaught TypeError on `.length`.
      imageBase64: 12345,
      mimeType: "image/png",
    });
    expect(result).toEqual({ ok: false, error: { type: "invalid-base64", reason: "imageBase64 must be a string" } });
  });
});

describe("setPageImage — wrong revision", () => {
  it("fails as a recognizable revision-conflict carrying the current actualRevision, and does not mutate the workspace", async () => {
    const { storage, storySlug, chapterSlug, revision } = await setupStoryWith();

    const result = await setPageImage(storage, {
      expectedRevision: revision + 5,
      storySlug,
      chapterSlug,
      imageBase64: toBase64(VALID_PNG),
      mimeType: "image/png",
    });
    expect(result).toEqual({
      ok: false,
      error: { type: "mutation-rejected", error: { type: "revision-conflict", expectedRevision: revision + 5, actualRevision: revision } },
    });

    const snapshot = await storage.list();
    expect(snapshot.revision).toBe(revision);
  });
});

describe("setPageImage — other rejection surfaces", () => {
  it("rejects a storySlug that doesn't match the current story", async () => {
    const { storage, chapterSlug, revision } = await setupStoryWith();

    const result = await setPageImage(storage, {
      expectedRevision: revision,
      storySlug: "some-other-story",
      chapterSlug,
      imageBase64: toBase64(VALID_PNG),
      mimeType: "image/png",
    });
    expect(result).toEqual({
      ok: false,
      error: { type: "story-mismatch", expectedStorySlug: "some-other-story", actualStorySlug: "agent-story" },
    });
  });

  it("rejects an unknown chapterSlug with the known slug list, and does not mutate the workspace", async () => {
    const { storage, storySlug, revision } = await setupStoryWith();

    const result = await setPageImage(storage, {
      expectedRevision: revision,
      storySlug,
      chapterSlug: "no-such-page",
      imageBase64: toBase64(VALID_PNG),
      mimeType: "image/png",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ type: "chapter-not-found", knownChapterSlugs: expect.arrayContaining(["page-01"]) });

    const snapshot = await storage.list();
    expect(snapshot.revision).toBe(revision);
  });

  it("rejects malformed base64", async () => {
    const { storage, storySlug, chapterSlug, revision } = await setupStoryWith();

    const result = await setPageImage(storage, {
      expectedRevision: revision,
      storySlug,
      chapterSlug,
      imageBase64: "not valid base64!!! ===",
      mimeType: "image/png",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("invalid-base64");
  });

  it("rejects an empty image", async () => {
    const { storage, storySlug, chapterSlug, revision } = await setupStoryWith();

    const result = await setPageImage(storage, {
      expectedRevision: revision,
      storySlug,
      chapterSlug,
      imageBase64: "",
      mimeType: "image/png",
    });
    expect(result).toEqual({ ok: false, error: { type: "empty-image" } });
  });
});

describe("setPageImage — overwriting an existing page image", () => {
  it("overwrites the same page's image, deleting the old file when the extension changed", async () => {
    const { storage, storySlug, chapterSlug, revision } = await setupStoryWith();

    const first = await setPageImage(storage, {
      expectedRevision: revision,
      storySlug,
      chapterSlug,
      imageBase64: toBase64(VALID_PNG),
      mimeType: "image/png",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await setPageImage(storage, {
      expectedRevision: first.revision,
      storySlug,
      chapterSlug,
      imageBase64: toBase64(VALID_JPEG),
      mimeType: "image/jpeg",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const snapshot = await storage.list();
    expect(snapshot.entries.some((e) => e.path === `media/${chapterSlug}.png`)).toBe(false);
    expect(snapshot.entries.some((e) => e.path === `media/${chapterSlug}.jpg`)).toBe(true);

    const mediaJsonFile = await storage.readFile("media.json");
    const mediaJson = JSON.parse((mediaJsonFile as { text: string }).text);
    expect(mediaJson[chapterSlug]).toEqual({ file: `${chapterSlug}.jpg` });
  });

  it("overwrites the same page's image in place when the extension stays the same", async () => {
    const { storage, storySlug, chapterSlug, revision } = await setupStoryWith();

    const first = await setPageImage(storage, {
      expectedRevision: revision,
      storySlug,
      chapterSlug,
      imageBase64: toBase64(VALID_PNG),
      mimeType: "image/png",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const biggerPng = bytesOf(PNG_SIGNATURE, fillerBytes(64));
    const second = await setPageImage(storage, {
      expectedRevision: first.revision,
      storySlug,
      chapterSlug,
      imageBase64: toBase64(biggerPng),
      mimeType: "image/png",
    });
    expect(second.ok).toBe(true);

    const snapshot = await storage.list();
    const entries = snapshot.entries.filter((e) => e.path === `media/${chapterSlug}.png`);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.byteLength).toBe(biggerPng.length);
  });
});
