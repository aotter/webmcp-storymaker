// Readiness — a parent-readable report on whether this story is
// complete yet. This is not a gate (it never blocks an operation, never throws,
// never refuses); it is a diagnostic computed fresh on every call, for the
// WebMCP tool surface `get_story_readiness` to call.
//
// Stance:
//   - Every call inspects the current workspace fresh, with zero caching — no
//     internal state, a plain storage -> report function.
//   - The checks are the reasonable minimal set: whether the story
//     exists, StorySpec validate() diagnostics (errors and warnings listed
//     separately), content completeness (whether the content/<chapterSlug>.en.txt
//     file for each content ref exists and is non-empty), media completeness
//     (whether the files referenced by media.json exist).
//   - Return both structured data and a parent-readable English summary.
//
// Consistency (race awareness, the same family as the read-consistency fix in
// ./readStory.ts): this function has to produce a single report across three
// sources — the spec/diagnostics returned by readStory() (corresponding to some
// revision R), the contents of media.json, and the workspace's current file list
// (used to determine whether content/media files exist and how big they are). If
// these three belong to different workspace versions (for example, the spec is
// stale but the file list already reflects the result of a concurrent mutate()
// that ran after it), the report ends up describing a combination that never
// actually existed — the same torn-read problem, just spanning three sources this
// time instead of the two in the original readStory.ts (readFile("story.yaml") vs
// list()).
//
// Approach: readStory(storage) itself already reads "consistently with some
// revision" (see the readStory.ts file header); once we have the revision it
// returns, we use readConsistentSnapshot() (added in ../workspace/snapshot.ts) to
// read "whatever other files this round needs" again (currently just media.json,
// only read if it exists) and confirm that this round's snapshot revision matches
// the revision returned by readStory() — only when all three line up does the
// report describe a workspace version that genuinely existed at some point. If any
// check fails to line up (readStory()'s own torn-read retries are exhausted, or the
// extra read here tears, or the two revisions don't match), the whole round is
// retried; once the retry limit is exhausted, we return an explicit
// unreadable(workspace-busy) — we do not pretend to have assembled a clean report.
import type { Diagnostic, StorySpec } from "../contract/types.ts";
import type { WorkspaceEntry, WorkspaceSnapshot } from "../workspace/types.ts";
import type { WorkspaceStoragePort } from "../ports.ts";
import { CONSISTENT_READ_MAX_ATTEMPTS, readConsistentSnapshot } from "../workspace/snapshot.ts";
import { findBrokenMediaReferences, parseMediaJson } from "../workspace/media.ts";
import { readStory } from "./readStory.ts";
import { collectReferencedChapterSlugs } from "./refs.ts";

/** The reason a page has "no content": either the corresponding
 * content/<chapterSlug>.en.txt file does not exist at all, or it exists but is
 * empty (byteLength 0 — updatePageText itself never allows a page to be explicitly
 * written as blank, so the only way to reach this state is a chapterSlug that has
 * never had content written to it via updatePageText. To a parent both cases just
 * mean "this page isn't written yet", so there's no need to distinguish them, but
 * the structured data still keeps the distinction for future UI use). */
export interface ContentGap {
  readonly chapterSlug: string;
  readonly reason: "missing-file" | "empty";
}

export interface ReadinessMedia {
  /** The list of paths referenced by media.json for which the workspace actually
   * has no matching file (in the `media/<file>` shape, the same shape as
   * ../workspace/media.ts findBrokenMediaReferences's return value). */
  readonly missing: readonly string[];
  /** media.json exists, but its contents are not valid JSON — this shouldn't
   * happen in theory (the browser side's only write entry point always validates
   * legal JSON before it lands, see ../workspace/mutate.ts). readiness reports, it
   * doesn't gate: when this happens we don't throw, we flag it so the caller knows
   * "this part can't be checked right now". */
  readonly unparsable: boolean;
}

export interface ReadinessContent {
  /** The total number of chapterSlugs currently referenced by story.yaml (the size
   * of the collectReferencedChapterSlugs set). */
  readonly totalReferenced: number;
  readonly missing: readonly ContentGap[];
}

export interface ReadinessDiagnostics {
  readonly errors: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
}

/** The story hasn't been created yet (there is no story.yaml in the workspace) —
 * this is not an error, it's a valid initial state. */
export interface ReadinessNotStarted {
  readonly status: "not-started";
  readonly summary: string;
}

/** A story that cannot be read for inspection — either story.yaml's syntax itself
 * is broken, or the workspace kept changing during the read and the retries were
 * exhausted without ever getting a consistent snapshot. Neither case has anything
 * to do with "how well-written the story is"; they're read-layer problems and are
 * not mixed into the ready/incomplete judgment. */
export interface ReadinessUnreadable {
  readonly status: "unreadable";
  readonly reason: { readonly type: "invalid-yaml" | "workspace-busy"; readonly detail: string };
  readonly summary: string;
}

export interface ReadinessReport {
  readonly status: "ready" | "incomplete";
  /** The workspace revision this report corresponds to — proof of freshness: if the
   * same storage was mutated between two calls, this revision will differ, and the
   * caller can use it to prove "this isn't a cached result". */
  readonly revision: number;
  readonly diagnostics: ReadinessDiagnostics;
  readonly content: ReadinessContent;
  readonly media: ReadinessMedia;
  readonly summary: string;
}

export type StoryReadiness = ReadinessNotStarted | ReadinessUnreadable | ReadinessReport;

function computeContentGaps(spec: StorySpec, entries: readonly WorkspaceEntry[]): { totalReferenced: number; missing: ContentGap[] } {
  const chapterSlugs = [...collectReferencedChapterSlugs(spec)].sort();
  const missing: ContentGap[] = [];
  for (const chapterSlug of chapterSlugs) {
    // chapterSlug itself is already constrained to ^[a-z0-9-]+$ by CHAPTER_REF_RE
    // (../story/refs.ts) — that character set contains no regex special
    // characters, so it can be interpolated directly without escaping.
    const pattern = new RegExp(`^content/${chapterSlug}\\.en\\.txt$`);
    const matches = entries.filter((e) => e.kind === "text" && pattern.test(e.path));
    if (matches.length === 0) {
      missing.push({ chapterSlug, reason: "missing-file" });
    } else if (!matches.some((e) => e.byteLength > 0)) {
      missing.push({ chapterSlug, reason: "empty" });
    }
  }
  return { totalReferenced: chapterSlugs.length, missing };
}

function computeMediaGaps(mediaJsonText: string | undefined, entries: readonly WorkspaceEntry[], chapterSlugs: ReadonlySet<string>): ReadinessMedia {
  if (mediaJsonText === undefined) return { missing: [], unparsable: false };
  const media = parseMediaJson(mediaJsonText, chapterSlugs);
  if (!media.ok) return { missing: [], unparsable: true };
  return { missing: findBrokenMediaReferences(media.value, new Set(entries.map((e) => e.path))), unparsable: false };
}

function buildSummary(params: {
  diagnostics: ReadinessDiagnostics;
  content: ReadinessContent;
  media: ReadinessMedia;
}): string {
  const issues: string[] = [];
  if (params.diagnostics.errors.length > 0) {
    const n = params.diagnostics.errors.length;
    issues.push(`The story structure has ${n} ${n === 1 ? "error" : "errors"} that need fixing.`);
  }
  if (params.content.missing.length > 0) {
    const n = params.content.missing.length;
    const names = params.content.missing.map((g) => g.chapterSlug).join(", ");
    issues.push(`${n} ${n === 1 ? "page is" : "pages are"} still missing content: ${names}.`);
  }
  if (params.media.unparsable) {
    issues.push("The media index file can't be parsed right now, so media completeness can't be checked.");
  } else if (params.media.missing.length > 0) {
    const n = params.media.missing.length;
    issues.push(`${n} media ${n === 1 ? "file is" : "files are"} missing.`);
  }

  const warningSuffix =
    params.diagnostics.warnings.length > 0
      ? ` (Plus ${params.diagnostics.warnings.length} ${params.diagnostics.warnings.length === 1 ? "note" : "notes"} that don't affect completeness.)`
      : "";

  if (issues.length === 0) return `The story is complete.${warningSuffix}`;
  return `${issues.join(" ")}${warningSuffix}`;
}

/**
 * Inspects the current workspace's story completeness fresh — zero caching, every
 * call re-reads from scratch (readStory() itself already has consistency retries;
 * this adds one more layer of consistency checking across
 * story.yaml/media.json/file-list, see the file header). Never throws, never
 * refuses: a story that "isn't finished yet" still gets a full report back, just
 * with status "incomplete".
 */
export async function getStoryReadiness(storage: WorkspaceStoragePort): Promise<StoryReadiness> {
  for (let attempt = 1; attempt <= CONSISTENT_READ_MAX_ATTEMPTS; attempt++) {
    const storyResult = await readStory(storage);
    if (!storyResult.ok) {
      if (storyResult.error.type === "story-not-found") {
        return {
          status: "not-started",
          summary: "This workspace doesn't have a story yet. Create one first, then completeness can be checked. Aim for 5 pages and two endings as a starting goal.",
        };
      }
      if (storyResult.error.type === "invalid-yaml") {
        return {
          status: "unreadable",
          reason: { type: "invalid-yaml", detail: storyResult.error.reason },
          summary: "The story file can't be read right now (it's corrupted). It needs to be fixed before completeness can be checked.",
        };
      }
      // workspace-busy — readStory() has already internally retried
      // CONSISTENT_READ_MAX_ATTEMPTS times without getting a consistent snapshot;
      // we don't retry the same thing again here, we report busy right away.
      return {
        status: "unreadable",
        reason: { type: "workspace-busy", detail: storyResult.error.reason },
        summary: "The workspace is changing too quickly right now to check completeness. Please try again in a moment.",
      };
    }

    const revision = storyResult.revision;

    const extra = await readConsistentSnapshot(storage, async (before) => {
      const hasMediaJson = before.entries.some((e) => e.path === "media.json");
      if (!hasMediaJson) return undefined;
      const file = await storage.readFile("media.json");
      return file?.kind === "text" ? file.text : undefined;
    });
    if (!extra.ok) continue; // the media.json/file-list read itself tore — retry the whole round
    if (extra.snapshot.revision !== revision) continue; // the workspace changed again after readStory() — retry the whole round

    const snapshot: WorkspaceSnapshot = extra.snapshot;
    const diagnostics: ReadinessDiagnostics = {
      errors: storyResult.diagnostics.filter((d) => d.severity === "error"),
      warnings: storyResult.diagnostics.filter((d) => d.severity === "warning"),
    };
    const content = computeContentGaps(storyResult.spec, snapshot.entries);
    const media = computeMediaGaps(extra.value, snapshot.entries, collectReferencedChapterSlugs(storyResult.spec));
    const summary = buildSummary({ diagnostics, content, media });
    const status = diagnostics.errors.length === 0 && content.missing.length === 0 && !media.unparsable && media.missing.length === 0
      ? "ready"
      : "incomplete";

    return { status, revision, diagnostics, content, media, summary };
  }

  return {
    status: "unreadable",
    reason: {
      type: "workspace-busy",
      detail: `the workspace kept changing while checking completeness; after ${CONSISTENT_READ_MAX_ATTEMPTS} retries a consistent snapshot still could not be obtained, please try again in a moment`,
    },
    summary: "The workspace is changing too quickly right now to check completeness. Please try again in a moment.",
  };
}
