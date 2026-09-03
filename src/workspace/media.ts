/** The closed media.json contract: one current illustration per chapter. */
export type MediaJsonShape = Record<string, { readonly file: string }>;

const SLUG_RE = /^[a-z0-9-]+$/;
const FILE_RE = /^([a-z0-9-]+)\.(png|jpg|jpeg|webp)$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate the complete media index. Unknown fields are never ignored. */
export function parseMediaJson(text: string | undefined, knownChapterSlugs?: ReadonlySet<string>): { readonly ok: true; readonly value: MediaJsonShape } | { readonly ok: false; readonly reason: string } {
  if (text === undefined) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "media.json is not valid JSON" };
  }
  if (!isObject(parsed)) return { ok: false, reason: "media.json must be an object" };
  const result: Record<string, { file: string }> = {};
  for (const [chapterSlug, entry] of Object.entries(parsed)) {
    if (!SLUG_RE.test(chapterSlug)) return { ok: false, reason: "media.json has an invalid chapter slug" };
    if (knownChapterSlugs && !knownChapterSlugs.has(chapterSlug)) return { ok: false, reason: "media.json references a chapter that does not exist" };
    if (!isObject(entry) || Object.keys(entry).length !== 1 || typeof entry.file !== "string") {
      return { ok: false, reason: "each media.json entry must be { file }" };
    }
    const fileMatch = FILE_RE.exec(entry.file);
    if (!fileMatch || fileMatch[1] !== chapterSlug) {
      return { ok: false, reason: "each media file must be <chapterSlug>.png|jpg|jpeg|webp" };
    }
    result[chapterSlug] = { file: entry.file };
  }
  return { ok: true, value: result };
}

/** Return missing workspace paths for a previously validated media index. */
export function findBrokenMediaReferences(media: MediaJsonShape, knownPaths: ReadonlySet<string>): string[] {
  const broken: string[] = [];
  for (const { file } of Object.values(media)) {
    const path = `media/${file}`;
    if (!knownPaths.has(path)) broken.push(path);
  }
  return broken;
}
