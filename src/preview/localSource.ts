// LocalSource - the first implementation of PreviewSource
// (./source.ts), the creator's local preview. Reads the same browser tab's IndexedDB workspace
// directly (../ports.ts WorkspaceStoragePort), with no network/relay involved - the
// phone-QR-scan preview's RelaySource is a separate implementation (see ./relaySource.ts); both
// share the ./source.ts interface and depend on nothing from each other.
//
// Consistent reads: `readStory()` (../story/readStory.ts) already does optimistic retries
// against tear reads of story.yaml, and returns a spec/diagnostics pair consistent with some
// revision. But this file still needs to read meta.json, each node's matching
// `content/<chapterSlug>.<lang>.txt`, and the media/ file listing - this is the same family of
// problem as "one logical read spanning multiple storage calls" (see the "Consistency" section
// of the ../story/readiness.ts header), and follows readiness.ts's existing discipline exactly:
// an outer retry loop plus ../workspace/snapshot.ts's readConsistentSnapshot() to read
// "everything besides story.yaml"; after reading, it compares this round's snapshot revision
// against the revision readStory() returned, and restarts the whole round if they differ; only
// once both retry budgets are exhausted does it report unavailable (it never pretends to have
// assembled a snapshot that's consistent across versions).
//
// Image bytes are not read inside load() - PreviewSnapshot only carries metadata
// (id/mime/byteLength, see "image bytes are not stored inside the snapshot object" in the
// ../preview/snapshot.ts header); PreviewReader only calls image(id) when it actually needs to
// show a particular image, and only then does this file really readFile() the matching blob.
// id === chapterSlug === mediaSlug (the existing rule from ../map/model.ts's "the basis for
// the page <-> art mapping"; restated independently here rather than importing that file
// - see the same explanation in the ./buildPreviewSnapshot.ts header).
import { DEFAULT_LANG, chapterSlugFromRef, parseMetaTitle, readStory, resolveChapterLang } from "../story/index.ts";
import type { WorkspaceStoragePort } from "../ports.ts";
import { CONSISTENT_READ_MAX_ATTEMPTS, readConsistentSnapshot } from "../workspace/snapshot.ts";
import type { WorkspaceEntry } from "../workspace/types.ts";
import { buildPreviewSnapshot, type PreviewMediaFileInfo } from "./buildPreviewSnapshot.ts";
import type { PreviewLoadResult, PreviewSource } from "./source.ts";

/** The path shape of `media/<mediaSlug>.<ext>`, same as ../workspace/paths.ts's
 * MEDIA_FILE_PATTERN - what this needs to capture is "look up from the workspace entries
 * whether a given chapterSlug currently has an approved illustration file," not to validate
 * whether a path is well-formed (that's paths.ts's job). */
const MEDIA_FILE_RE = /^media\/([a-z0-9-]+)\.(png|jpg|jpeg|webp)$/;

function findMediaFile(entries: readonly WorkspaceEntry[], chapterSlug: string): PreviewMediaFileInfo | undefined {
  for (const entry of entries) {
    if (entry.kind !== "blob") continue;
    const match = MEDIA_FILE_RE.exec(entry.path);
    if (match && match[1] === chapterSlug) return { ext: match[2]!, byteLength: entry.byteLength };
  }
  return undefined;
}

/** Scans spec.nodes and collects the chapterSlug for each node (see
 * chapterSlugFromRef() in ../story/refs.ts) - a node with no resolvable content ref contributes
 * no chapterSlug, the same rule buildPreviewSnapshot() applies to such a node (its text falls
 * back to an empty string); this just collects the list first so the caller knows which files
 * to read. */
function collectChapterSlugs(nodes: Record<string, { content?: unknown }>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const node of Object.values(nodes)) {
    const slug = chapterSlugFromRef(node.content);
    if (slug !== undefined) out.add(slug);
  }
  return out;
}

export class LocalSource implements PreviewSource {
  readonly #storage: WorkspaceStoragePort;

  constructor(storage: WorkspaceStoragePort) {
    this.#storage = storage;
  }

  async load(): Promise<PreviewLoadResult> {
    try {
      return await this.#loadWithRetries();
    } catch {
      // An underlying storage call (IndexedDB quota exhausted,
      // private-browsing restrictions, ...) may throw directly instead of returning a
      // structured failure - this is the one place that knows "this is LocalSource's own
      // storage exception," and it collapses it into unavailable (a retryable meaning). It
      // never exposes the raw exception content (which may contain technical strings); the
      // fixed message is decided by ./messages.ts. The caller (../preview/reader.ts init())
      // still keeps its own try/catch as a second line of defense, but that guards against
      // "something outside this method" breaking, not a deliberate design where both layers
      // handle the same exception redundantly.
      return { ok: false, error: { type: "unavailable" } };
    }
  }

  async #loadWithRetries(): Promise<PreviewLoadResult> {
    for (let attempt = 1; attempt <= CONSISTENT_READ_MAX_ATTEMPTS; attempt++) {
      const storyResult = await readStory(this.#storage);
      if (!storyResult.ok) {
        if (storyResult.error.type === "story-not-found") return { ok: false, error: { type: "no-story" } };
        if (storyResult.error.type === "invalid-yaml") {
          return { ok: false, error: { type: "invalid-story", reason: storyResult.error.reason } };
        }
        // workspace-busy - readStory() has already internally retried
        // CONSISTENT_READ_MAX_ATTEMPTS times and still couldn't get a consistent snapshot;
        // this doesn't retry the same thing again, and just reports busy right away (the same
        // discipline as ../story/readiness.ts).
        return { ok: false, error: { type: "unavailable", reason: storyResult.error.reason } };
      }

      const chapterSlugs = collectChapterSlugs(storyResult.spec.nodes ?? {});

      const extra = await readConsistentSnapshot(this.#storage, async (before) => {
        const metaFile = before.entries.some((e) => e.path === "meta.json") ? await this.#storage.readFile("meta.json") : undefined;
        const metaJsonText = metaFile?.kind === "text" ? metaFile.text : undefined;

        const pageContent = new Map<string, string>();
        for (const slug of chapterSlugs) {
          const lang = resolveChapterLang(before.entries, slug, DEFAULT_LANG);
          const file = await this.#storage.readFile(`content/${slug}.${lang}.txt`);
          if (file?.kind === "text") pageContent.set(slug, file.text);
        }

        const mediaFiles = new Map<string, PreviewMediaFileInfo>();
        for (const slug of chapterSlugs) {
          const media = findMediaFile(before.entries, slug);
          if (media) mediaFiles.set(slug, media);
        }

        return { metaJsonText, pageContent, mediaFiles };
      });

      if (!extra.ok) {
        return {
          ok: false,
          error: {
            type: "unavailable",
            reason: `The workspace was busy while reading; still couldn't get a consistent snapshot after ${CONSISTENT_READ_MAX_ATTEMPTS} retries.`,
          },
        };
      }
      if (extra.snapshot.revision !== storyResult.revision) continue; // The workspace changed again after readStory(), so restart the whole round

      const title = parseMetaTitle(extra.value.metaJsonText) ?? storyResult.spec.metadata.slug;
      const built = buildPreviewSnapshot({
        spec: storyResult.spec,
        diagnostics: storyResult.diagnostics,
        revision: storyResult.revision,
        title,
        pageContent: extra.value.pageContent,
        mediaFiles: extra.value.mediaFiles,
      });
      if (!built.ok) return { ok: false, error: { type: "invalid-story", reason: built.error.reason } };
      return { ok: true, snapshot: built.snapshot };
    }

    return {
      ok: false,
      error: {
        type: "unavailable",
        reason: `The workspace kept changing while the preview was being read; still couldn't get a consistent snapshot after ${CONSISTENT_READ_MAX_ATTEMPTS} retries.`,
      },
    };
  }

  async image(id: string): Promise<Uint8Array | undefined> {
    // id is interpolated directly into the regex - safe for the same reason as the existing
    // precedent in ../ui/controller.ts readAcceptedMedia(): the caller (PreviewReader) only
    // ever calls this with a PreviewImageMeta.id returned from load(), and that id is already
    // constrained by buildPreviewSnapshot() to a chapterSlug (CHAPTER_REF_RE's character set
    // ^[a-z0-9-]+$), which contains no regex special characters.
    try {
      const pattern = new RegExp(`^media/${id}\\.(?:png|jpg|jpeg|webp)$`);
      const snapshot = await this.#storage.list();
      const entry = snapshot.entries.find((e) => e.kind === "blob" && pattern.test(e.path));
      if (!entry) return undefined;
      const file = await this.#storage.readFile(entry.path);
      return file?.kind === "blob" ? file.bytes : undefined;
    } catch {
      // The same collapsing rationale as load() - a storage exception
      // and "this image wasn't found" are the same outcome as far as the caller is concerned
      // (keep the blank placeholder, never fabricate an image, following the existing
      // precedent in ./reader.ts showImage()); there's no need to invent a second error
      // meaning here.
      return undefined;
    }
  }

  dispose(): void {
    // LocalSource holds no resources that need releasing - it caches no state; load()/image()
    // each go straight to storage fresh every time. This is a no-op the interface requires;
    // keeping the method means the caller (./reader.ts) doesn't need a separate branch to ask
    // "does this source even have a dispose to call."
  }
}
