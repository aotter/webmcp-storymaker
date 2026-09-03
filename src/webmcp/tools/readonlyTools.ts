// Read-only WebMCP tools -- the first time an agent can actually read a story through
// WebMCP.
//
// Location rationale: this lives in
// `src/webmcp/tools/`, not `src/story/tools.ts`. The reason is dependency direction: the tool
// definitions here consume both `src/story/` (domain capabilities: readStory/getStoryReadiness/
// collectReferencedChapterSlugs) **and** `../types.ts`'s `WebMcpToolDefinition` (the WebMCP
// protocol shape) -- if the tool definitions lived inside `src/story/`, it would flip things
// around and make the story domain layer import WebMCP types, inverting the direction that
// `docs/architecture.md` and the header of `../types.ts` repeatedly stress ("don't scatter WebMCP
// types into the domain layer"). `src/webmcp/tools/` keeps the one-way dependency of "story is a
// pure domain layer, webmcp/ is an adapter layer that consumes domain capabilities and repackages
// them into the protocol shape": story -> (consumed by) <- webmcp/tools -> webmcp/types. The
// write tools are this file's sibling (`writeTools.ts`), same directory, same dependency
// direction.
//
// The three tools:
//   - `inspect_story` -- an overview of the story's current state (metadata, each page's
//     chapterSlug + whether it has text + a coarse length summary, a summary of validate()
//     diagnostics, revision). **Never returns any page's full text, and never returns media
//     bytes** -- chapter content is expressed as a coarse length tier (empty/short/medium/long)
//     saying roughly "about how much has been written for this page," not sending the actual text
//     of `content/<chapterSlug>.<lang>.txt` to the model; this is where the requirement that
//     "the tool must not return unauthorized data, arbitrary file content, or media bytes" lands
//     in this tool.
//   - `get_story_readiness` -- directly wires up `getStoryReadiness()`, outputting
//     the structured data + parent-readable summary as-is, no repackaging.
//   - `get_editor_focus` -- directly wires up `FocusController.getFocus()`. A fake
//     focus is already blocked at the `FocusController` layer by `setFocus()`/`getFocus()`'s
//     internal validation (see the "state machine" note in the header of
//     `../../story/focus.ts`) -- this tool only reads the already-validated current focus, so
//     "a fake focus never becomes model-visible" is naturally satisfied without re-validating
//     here.
//
// Consistency discipline: `inspect_story` needs to stitch a report together across two sources,
// `story.yaml` (spec/diagnostics/revision) and `meta.json` (book title) -- it directly reuses
// `../../story/readStory.ts`'s consistent read plus `../../workspace/snapshot.ts`'s
// `readConsistentSnapshot()` (the same skeleton `../../story/readiness.ts` already uses for
// media.json -- here we apply the same technique to meta.json) -- it doesn't hand-roll another
// round of raw `list()`/`readFile()`. `get_story_readiness`/`get_editor_focus` are simpler: they
// call the story layer's ready-made `getStoryReadiness()`/`FocusController.getFocus()` directly
// -- those two already have their own consistency retries, no need to redo it here. When the
// workspace is busy (retries exhausted), always return a structured `status: "unreadable"`/
// `reason.type: "workspace-busy"` plus a human-readable "try again later" summary, never throw --
// the caller (the agent) can tell "should I ask again" without needing try/catch.
//
// `inspect_story`/`get_story_readiness` must not pass through the story layer's returned
// `Diagnostic[]` (including free-text `message`) or the `invalid-yaml`'s original parser error
// text unchanged -- `checkRefField()`
// (`story-contract`'s `validate.ts`) embeds the raw value (`JSON.stringify(v)` or a bare string)
// into `message` when a field's shape is wrong, and `yaml@2.9.0`'s parse errors also carry the
// original text of the offending line, both of which are enough to leak, through this read-only
// tool, an entire block of text a user accidentally put in the wrong field. The fix lives in
// `./safeDiagnostics.ts` (the WebMCP adapter boundary, not the story layer/`validate.ts` -- those
// two should still give the UI/internal callers the full message): `summarizeDiagnostics()`
// converts `Diagnostic[]` into a summary without `message`, keeping only error/warning counts and
// a fixed category safely derived from the path structure; `INVALID_YAML_DETAIL` is fixed wording
// that replaces the parser's original text. Both tools share the same conversion (not converted
// separately in each).
//
// Two more free-text exits are closed the same way -- the safe DTO layer's responsibility is to
// only expose values already proven safe, and it
// cannot rely on "the caller can't currently write this in" -- the workspace could come from
// existing data / a future UI / a future write tool, not just this tool's own call path:
//   1. `inspect_story.metadata.slug` -- `readStory()` returns a spec unchanged even when it's
//      "syntactically legal, semantically illegal" (the read layer's existing stance -- it
//      doesn't reject on semantic illegality), and `metadata.slug`'s `SLUG_RE` on the
//      story-contract side is only a diagnostic, not a gate that blocks reads -- an illegal slug
//      (which could carry a mark the user accidentally put there) gets read out by `readStory()`
//      unchanged, just like anything else. This re-validates at the DTO boundary (same precedent
//      as `../../story/createMinimalStory.ts`: it doesn't import story-contract's unexported
//      internal `SLUG_RE` -- the browser layer restates the same rule itself), and only returns
//      the `slug` field when it's legal -- otherwise the field is omitted and only `slugValid:
//      false` is given (a closed shape -- the agent can tell "slug has no value because it's
//      currently illegal," instead of mistaking it for the workspace being busy or the story not
//      existing).
//   2. `title` (meta.json's book title) -- keep it, but add a length cap (see
//      `truncateTitle()` below). `title` is different in nature from the two free-text exits
//      above: it's a public label the author already means for the agent/reader to see (the book
//      title), not "body text accidentally stuffed into a structural field" -- removing it would
//      leave `inspect_story` unable to mention the story's name in conversation, which goes too
//      far. But like the others, it has no length/character-set limit at all (`createMinimalStory.ts`
//      only blocks an empty string), and could in principle be written as an entire page of body
//      text (e.g. by a future write_meta tool, or by existing data that already had no length
//      limit on meta.json) -- truncating at a fixed character count (rather than passing it
//      through unbounded) is the compromise between these two positions: a genuine book title is
//      always far under the cap, and anything over the cap is truncated with a clear marker, never
//      pretending the truncated string is the complete title.
import type { StorySpec } from "../../contract/types.ts";
import type { WorkspaceStoragePort } from "../../ports.ts";
import type { FocusController, Focus, FocusTab } from "../../story/focus.ts";
import { collectReferencedChapterSlugs, getStoryReadiness, parseMetaTitle, readStory, type StoryReadiness } from "../../story/index.ts";
import { CONSISTENT_READ_MAX_ATTEMPTS, readConsistentSnapshot } from "../../workspace/snapshot.ts";
import type { WorkspaceEntry } from "../../workspace/types.ts";
import type { WebMcpToolDefinition } from "../types.ts";
import { INVALID_YAML_DETAIL, summarizeDiagnostics, type SafeDiagnosticsSummary } from "./safeDiagnostics.ts";

/** The empty input schema shared by all three read-only tools -- a single-story workspace
 * (docs/architecture.md) doesn't need a story id parameter; the agent calls these with no fields
 * at all. `additionalProperties: false` lets the agent tell at a glance from the schema that this
 * tool takes no input, without having to guess. */
const EMPTY_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;

// ---------- inspect_story ----------

/** A page's length tier -- only gives a rough sense of "about how much has been written," not an
 * exact count, and definitely not the full text (per the acceptance criteria: "the tool must not
 * return unauthorized data, arbitrary file content"). The thresholds use UTF-8 byteLength
 * (something workspace `list()` already provides for free, no extra `readFile()` needed): these
 * thresholds roughly map to "zero characters / a few dozen or fewer / a short paragraph / a full
 * page" across four tiers -- the tiering itself is this tool's own internal judgment call, not a
 * threshold fixed by any spec. */
type ContentLengthTier = "empty" | "short" | "medium" | "long";

function tierOf(byteLength: number): ContentLengthTier {
  if (byteLength <= 0) return "empty";
  if (byteLength < 200) return "short";
  if (byteLength < 800) return "medium";
  return "long";
}

export interface InspectStoryChapterSummary {
  readonly chapterSlug: string;
  /** Whether this page currently has a non-empty content fragment (any language) in the workspace. */
  readonly hasContent: boolean;
  readonly lengthTier: ContentLengthTier;
}

/** Same `metadata.slug` rule as `story-contract`'s `validate.ts` -- that constant isn't exported,
 * so the browser layer restates the same rule itself, same existing precedent as
 * `../../story/createMinimalStory.ts` (see that file's header "SLUG_RE" note) -- it doesn't
 * import that file's internal private constant. */
const SLUG_RE = /^[a-z0-9-]+$/;

/** Length cap for `title` (in Unicode code points, not UTF-16 code units, to avoid cutting a
 * surrogate pair/emoji in half) -- see the `title` note in the header above: a genuine
 * book title is always far below this number; this is only a cap to keep this field from being
 * used as a free-text exit, not a threshold fixed by any spec. */
const TITLE_MAX_CODEPOINTS = 80;

/** Truncate and append a clear marker when over the cap -- never pretend the truncated string is
 * the complete title. Uses `Array.from(title)` to slice code point by code point, not `.slice()`
 * (which works on UTF-16 code units and can cut a surrogate pair/emoji in half). */
function truncateTitle(title: string): string {
  const codepoints = Array.from(title);
  if (codepoints.length <= TITLE_MAX_CODEPOINTS) return title;
  return `${codepoints.slice(0, TITLE_MAX_CODEPOINTS).join("")}...(truncated)`;
}

/** A DTO-boundary-safe version of metadata -- `slug` only appears when it passes `SLUG_RE`
 * (omitted otherwise; `slugValid` is always present, so the agent can tell "there's no slug here
 * because it's illegal, not because the field is missing"); `title` has already gone through
 * `truncateTitle()`. */
export interface InspectStoryMetadata {
  readonly slugValid: boolean;
  readonly slug?: string;
  readonly title?: string;
}

function buildSafeMetadata(rawSlug: string, rawTitle: string | undefined): InspectStoryMetadata {
  const slugValid = SLUG_RE.test(rawSlug);
  const title = rawTitle === undefined ? undefined : truncateTitle(rawTitle);
  return {
    slugValid,
    ...(slugValid ? { slug: rawSlug } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}

export interface InspectStoryFound {
  readonly status: "found";
  readonly revision: number;
  readonly metadata: InspectStoryMetadata;
  readonly chapters: readonly InspectStoryChapterSummary[];
  /** Safe summary (see ./safeDiagnostics.ts) -- excludes `Diagnostic.message` free text, per the
   * review fix. */
  readonly diagnostics: SafeDiagnosticsSummary;
  readonly summary: string;
}

export interface InspectStoryNotStarted {
  readonly status: "not-started";
  readonly summary: string;
}

export interface InspectStoryUnreadable {
  readonly status: "unreadable";
  readonly reason: { readonly type: "invalid-yaml" | "workspace-busy"; readonly detail: string };
  readonly summary: string;
}

export type InspectStoryResult = InspectStoryFound | InspectStoryNotStarted | InspectStoryUnreadable;

function buildChapterSummaries(spec: StorySpec, entries: readonly WorkspaceEntry[]): InspectStoryChapterSummary[] {
  const chapterSlugs = [...collectReferencedChapterSlugs(spec)].sort();
  return chapterSlugs.map((chapterSlug) => {
    // Same matching rule as ../../story/readiness.ts's computeContentGaps: chapterSlug has
    // already been constrained by CHAPTER_REF_RE (../../story/refs.ts) to ^[a-z0-9-]+$, so
    // interpolating it directly needs no escaping.
    const pattern = new RegExp(`^content/${chapterSlug}\\.[a-z]{2}\\.txt$`);
    const matches = entries.filter((e) => e.kind === "text" && pattern.test(e.path));
    const maxBytes = matches.reduce((max, e) => Math.max(max, e.byteLength), 0);
    return { chapterSlug, hasContent: matches.some((e) => e.byteLength > 0), lengthTier: tierOf(maxBytes) };
  });
}

function buildInspectSummary(params: {
  metadata: InspectStoryMetadata;
  chapters: readonly InspectStoryChapterSummary[];
  diagnostics: SafeDiagnosticsSummary;
}): string {
  // The label only uses metadata.title, which has already gone through truncateTitle() -- it
  // uses the same safe value as the metadata field itself, never pulling in the untruncated
  // original from anywhere else.
  const label = params.metadata.title ? `"${params.metadata.title}"` : "This story";
  const emptyCount = params.chapters.filter((c) => !c.hasContent).length;
  const parts = [`${label} has ${params.chapters.length} pages`];
  if (!params.metadata.slugValid) parts.push("the slug format is invalid");
  if (emptyCount > 0) parts.push(`${emptyCount} pages still have no text`);
  if (params.diagnostics.errorCount > 0) parts.push(`${params.diagnostics.errorCount} structural errors`);
  if (params.diagnostics.warningCount > 0) parts.push(`${params.diagnostics.warningCount} warnings`);
  return `${parts.join(", ")}.`;
}

async function inspectStory(storage: WorkspaceStoragePort): Promise<InspectStoryResult> {
  for (let attempt = 1; attempt <= CONSISTENT_READ_MAX_ATTEMPTS; attempt++) {
    const storyResult = await readStory(storage);
    if (!storyResult.ok) {
      if (storyResult.error.type === "story-not-found") {
        return {
          status: "not-started",
          summary: "This workspace has no story yet. Create one before checking the overview. Aim for about 5 pages with two endings.",
        };
      }
      if (storyResult.error.type === "invalid-yaml") {
        // Fixed wording, never passes through the yaml parser's Error.message -- a parser error's
        // original text carries the raw content around the offending line (see
        // ./safeDiagnostics.ts's INVALID_YAML_DETAIL header note, review fix).
        return {
          status: "unreadable",
          reason: { type: "invalid-yaml", detail: INVALID_YAML_DETAIL },
          summary: "The story file can't be read right now (its format is corrupted); it needs to be fixed before you can check the overview.",
        };
      }
      // workspace-busy -- readStory() has already retried internally CONSISTENT_READ_MAX_ATTEMPTS
      // times without getting a consistent snapshot, so this doesn't retry the same thing again;
      // it just reports busy directly (same approach as ../../story/readiness.ts).
      return {
        status: "unreadable",
        reason: { type: "workspace-busy", detail: storyResult.error.reason },
        summary: "The workspace is changing too fast right now to check the overview; please try again shortly.",
      };
    }

    const revision = storyResult.revision;
    const extra = await readConsistentSnapshot(storage, async (before) => {
      const hasMeta = before.entries.some((e) => e.path === "meta.json");
      if (!hasMeta) return undefined;
      const file = await storage.readFile("meta.json");
      return file?.kind === "text" ? file.text : undefined;
    });
    if (!extra.ok) continue; // the meta.json/file-list read itself tore -- redo the whole round
    if (extra.snapshot.revision !== revision) continue; // the workspace changed again after readStory() -- redo the whole round

    // slug is only returned once it passes SLUG_RE (omitted otherwise, leaving just slugValid:
    // false); title has already been truncated -- re-review fix, see the import note at the top
    // of this file and buildSafeMetadata()'s header.
    const metadata = buildSafeMetadata(storyResult.spec.metadata.slug, parseMetaTitle(extra.value));
    const chapters = buildChapterSummaries(storyResult.spec, extra.snapshot.entries);
    // Safe summary, excludes Diagnostic.message free text (review finding fix, see
    // ./safeDiagnostics.ts header).
    const diagnostics = summarizeDiagnostics(storyResult.diagnostics);

    return { status: "found", revision, metadata, chapters, diagnostics, summary: buildInspectSummary({ metadata, chapters, diagnostics }) };
  }

  return {
    status: "unreadable",
    reason: {
      type: "workspace-busy",
      detail: `The workspace kept changing while checking the overview; after ${CONSISTENT_READ_MAX_ATTEMPTS} retries a consistent snapshot still couldn't be obtained -- please try again shortly`,
    },
    summary: "The workspace is changing too fast right now to check the overview; please try again shortly.",
  };
}

function createInspectStoryTool(storage: WorkspaceStoragePort): WebMcpToolDefinition {
  return {
    name: "inspect_story",
    title: "Story overview",
    description:
      "Overview of the current story: title, slug, page ids, text status, validation summary, and " +
      "revision. It never returns full page text or image bytes. Use it before a first write, after " +
      "a revision conflict, or when page ids are needed. Empty workspaces return not-started.",
    inputSchema: EMPTY_INPUT_SCHEMA,
    annotations: { readOnlyHint: true },
    async execute(_input, { signal }) {
      if (signal.aborted) throw signal.reason ?? new Error("inspect_story: aborted");
      return inspectStory(storage);
    },
  };
}

// ---------- get_story_readiness ----------

/** A safe version of `ReadinessMedia` (../../story/readiness.ts) -- `missing` (an array of
 * `media/<file>` paths) is swapped for a plain count.
 * Every value in `missing` comes from `media.json`'s `file` fields
 * (`../../workspace/media.ts`'s `findBrokenMediaReferences()`), and neither field has any
 * character-set/length limit -- in principle it could be arbitrary text. The workspace's content
 * isn't determined solely by this
 * tool's own call path (`set_page_image`, a write tool, sets media.json; so does existing data,
 * so will future write tools) -- the safe DTO layer's responsibility is to only expose values
 * already proven safe, it cannot assume "the caller can't currently write this in." Switching to
 * a count (`missingCount`) doesn't affect `summary` (which already only reads `.length`, see
 * ./readiness.ts's buildSummary()) or `status` (the ready/incomplete decision is computed in the
 * story layer; this is only repackaging the display shape). */
export interface SafeReadinessMedia {
  readonly missingCount: number;
  readonly unparsable: boolean;
}

/** A safe version of `StoryReadiness` (../../story/readiness.ts) -- `content`/`revision`/
 * `summary` pass through unchanged (already confirmed: `content.missing`'s `chapterSlug` is
 * constrained by `../../story/refs.ts`'s `CHAPTER_REF_RE` (`^[a-z0-9-]+$`) allowlist, `reason` is
 * a closed enum; `summary` is a program-composed count sentence, see ./readiness.ts's
 * buildSummary(), no message text), while `diagnostics` (swapped for `SafeDiagnosticsSummary`),
 * `media` (swapped for `SafeReadinessMedia`) and the `unreadable` state's `invalid-yaml` detail
 * (swapped for fixed wording) must not pass through unchanged -- review finding (including the
 * re-review) fix, see the import note at the top of this file. */
export type SafeStoryReadiness =
  | Extract<StoryReadiness, { status: "not-started" }>
  | (Omit<Extract<StoryReadiness, { status: "unreadable" }>, "reason"> & {
      readonly reason: { readonly type: "invalid-yaml" | "workspace-busy"; readonly detail: string };
    })
  | (Omit<Extract<StoryReadiness, { status: "ready" | "incomplete" }>, "diagnostics" | "media"> & {
      readonly diagnostics: SafeDiagnosticsSummary;
      readonly media: SafeReadinessMedia;
    });

function toSafeStoryReadiness(readiness: StoryReadiness): SafeStoryReadiness {
  if (readiness.status === "not-started") return readiness;
  if (readiness.status === "unreadable") {
    // workspace-busy's detail is a fixed template string composed by
    // ../../story/readiness.ts/readStory.ts itself (it only carries the retry count, a constant,
    // never any user value) -- already confirmed safe, kept unchanged; invalid-yaml is swapped
    // for fixed wording (same reason as inspect_story, see ./safeDiagnostics.ts).
    const detail = readiness.reason.type === "invalid-yaml" ? INVALID_YAML_DETAIL : readiness.reason.detail;
    return { ...readiness, reason: { ...readiness.reason, detail } };
  }
  return {
    ...readiness,
    diagnostics: summarizeDiagnostics([...readiness.diagnostics.errors, ...readiness.diagnostics.warnings]),
    media: { missingCount: readiness.media.missing.length, unparsable: readiness.media.unparsable },
  };
}

function createStoryReadinessTool(storage: WorkspaceStoragePort): WebMcpToolDefinition {
  return {
    name: "get_story_readiness",
    title: "Story readiness check",
    description:
      "Check whether the story is ready to read. Returns structural diagnostics, pages missing " +
      "text, missing-image count, and a concise summary; it never returns page text or image bytes. " +
      "Status is not-started, unreadable, ready, or incomplete.",
    inputSchema: EMPTY_INPUT_SCHEMA,
    annotations: { readOnlyHint: true },
    async execute(_input, { signal }): Promise<SafeStoryReadiness> {
      if (signal.aborted) throw signal.reason ?? new Error("get_story_readiness: aborted");
      // No longer wired up unchanged (review finding fix) -- same DTO conversion, see
      // toSafeStoryReadiness() above.
      return toSafeStoryReadiness(await getStoryReadiness(storage));
    },
  };
}

// ---------- get_editor_focus ----------

// Fix (in response to a third round of review findings, confirmed -- the third exit for the same
// "data minimization" gap; the first two rounds fixed inspect_story/get_story_readiness, this
// rounds out get_editor_focus): `FocusController.setFocus()` (../../story/focus.ts's
// `validateClaim()`) only checks `claim.storySlug === spec.metadata.slug` (an equality
// comparison), it never validates `storySlug`'s own format -- a workspace where `metadata.slug`
// is syntactically legal but carries a body-text marker will still let
// `setFocus({ storySlug: <that illegal value> })` succeed (the value matches the current spec,
// the equality check passes), and `get_editor_focus` used to pass this `storySlug` straight
// through, wrapped in `{ status: "focused", focus }`, back to the model.
//
// Which layer to fix: fix it here (at the WebMCP boundary projection), not in
// `../../story/focus.ts` -- `FocusController` should still give the UI/internal callers the full
// real value, a layering principle this file has held since its first round of fixes (the same
// treatment as `../../story/readStory.ts`/`validate.ts`). We considered instead having
// `validateClaim()` also apply `SLUG_RE` to `claim.storySlug`, but that would change the UI's
// existing behavior: when the UI claims a focus for "the story currently in this workspace," the
// `storySlug` it passes *is* `spec.metadata.slug` itself -- if `metadata.slug` itself has an
// illegal format (whether or not that's because the user mistyped it), `validateClaim()` would
// reject even this normal "I'm claiming to be looking at the current story" operation, meaning
// the UI could never set a focus at all for this (rare but legally existing) kind of workspace --
// that's a bigger behavior change than "the model can't see the raw slug value," and isn't what
// this fix is meant to do. Safety filtering only happens at this WebMCP layer; the UI's
// `FocusController` is completely unaffected.
//
// Shape decision: between two options -- return `no-focus`, or another distinguishable
// shape -- this uses the distinguishable shape
// (`{ status: "focused", focus: { slugValid: false, chapterSlug?, tab? } }`, with `storySlug`
// omitted), not `no-focus`: `no-focus` would make the agent think the user isn't currently
// claiming to be looking at anything, when in fact there's a focus that's already passed
// validation and is still valid right now -- it's just that its story identifier has an illegal
// format and can't be safely shown. These are two different facts, and `no-focus` would erase the
// true signal that "there actually is a focus." The distinguishable shape uses the same semantics
// as `InspectStoryMetadata` (see `slugValid: false` above) -- the caller only needs to recognize
// one way of expressing "the slug has no value because it's illegal," it doesn't need a separate
// vocabulary invented just for focus.
//
// Re-review of the other fields (using the criterion established in the first two rounds: must
// be one of program constant / count / allowlist regex capture to count as safe):
//   - `chapterSlug`: `validateClaim()` checks it with `known.has(claim.chapterSlug)`, where
//     `known` is the return value of `collectReferencedChapterSlugs()` (../../story/refs.ts) --
//     that function only ever inserts the value captured by `CHAPTER_REF_RE`'s
//     (`^content:\/\/[a-z0-9-]+\/chapters\/([a-z0-9-]+)#fragments\/text$`) capture group 1, never
//     any raw/unfiltered string. `Set.has()` is an exact string-equality comparison, so any
//     `claim.chapterSlug` that passes this check must **equal** some value already captured by
//     that regex -- it can't be "a string that happens to pass `.has()` but was never itself
//     validated by that regex," a natural allowlist that doesn't need re-validating here.
//   - `tab`: `FocusTab = "structure" | "content" | "media"` is a closed enum, `validateClaim()`
//     checks membership with `isFocusTab()` -- a fixed constant set, safe.
// Neither needs to change.
export interface SafeFocus {
  readonly slugValid: boolean;
  readonly storySlug?: string;
  readonly chapterSlug?: string;
  readonly tab?: FocusTab;
}

export type EditorFocusResult = { readonly status: "no-focus" } | { readonly status: "focused"; readonly focus: SafeFocus };

function toSafeFocus(current: Focus): SafeFocus {
  const slugValid = SLUG_RE.test(current.storySlug);
  return {
    slugValid,
    ...(slugValid ? { storySlug: current.storySlug } : {}),
    ...(current.chapterSlug !== undefined ? { chapterSlug: current.chapterSlug } : {}),
    ...(current.tab !== undefined ? { tab: current.tab } : {}),
  };
}

function createEditorFocusTool(focus: FocusController): WebMcpToolDefinition {
  return {
    name: "get_editor_focus",
    title: "Current editor focus",
    description:
      "Return the currently validated UI focus (story, page, and tab), or no-focus. This is useful " +
      "context for a request, not a substitute for inspecting story structure.",
    inputSchema: EMPTY_INPUT_SCHEMA,
    annotations: { readOnlyHint: true },
    async execute(_input, { signal }): Promise<EditorFocusResult> {
      if (signal.aborted) throw signal.reason ?? new Error("get_editor_focus: aborted");
      const current = await focus.getFocus();
      return current === null ? { status: "no-focus" } : { status: "focused", focus: toSafeFocus(current) };
    },
  };
}

// ---------- Factory ----------

export interface ReadonlyToolsDeps {
  readonly storage: WorkspaceStoragePort;
  readonly focus: FocusController;
}

/** Per the original task wording: "the tool is a pure function factory:
 * `createReadonlyTools({ storage, focus }) -> WebMcpToolDefinition[]`" -- the `../../app.ts`
 * composition root calls this and hands the returned definitions in a batch to
 * `AppPorts.webMcp.registerTools()`. This file itself never touches `document.modelContext` and
 * doesn't know how the WebMCP facade mounts tools; it only handles the conversion from
 * "story-layer capability" to "WebMcpToolDefinition shape." */
export function createReadonlyTools(deps: ReadonlyToolsDeps): WebMcpToolDefinition[] {
  return [createInspectStoryTool(deps.storage), createStoryReadinessTool(deps.storage), createEditorFocusTool(deps.focus)];
}
