/** Canonical content-ref grammar shared by validation and workspace consumers. */
const CONTENT_REF_RE = /^content:\/\/([a-z0-9-]+)\/chapters\/([a-z0-9-]+)#fragments\/text$/;

export interface ContentRefParts {
  readonly storySlug: string;
  readonly chapterSlug: string;
}

export function parseContentRef(value: unknown): ContentRefParts | undefined {
  if (typeof value !== "string") return undefined;
  const match = CONTENT_REF_RE.exec(value);
  return match ? { storySlug: match[1], chapterSlug: match[2] } : undefined;
}

export function isContentRefForStory(value: unknown, storySlug: string): boolean {
  return parseContentRef(value)?.storySlug === storySlug;
}
