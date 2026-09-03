// `Diagnostic.message` (`story-contract`'s `validate.ts`) is free text meant for a human/the UI,
// and it embeds the raw field value that triggered the error unchanged -- `checkRefField()`
// inserts a field's value directly into the message as either a `bare string "${v}"` or
// `JSON.stringify(v)` whenever the field "has a value but isn't shaped like `{ $ref }`" (see that
// function in that file). The real attack surface: a user/agent accidentally writes a whole block
// of body text into a field like `content` that should hold `{ $ref }` (a bare string, not a
// reference object) -- `validate()`'s diagnostic message then carries that entire block of text
// unchanged. If `inspect_story`/`get_story_readiness` returned `Diagnostic[]` unchanged to the
// model, that would mean this read-only "story overview" tool bypasses the "never return full
// text" line that each operation function in `../../story/index.ts` deliberately holds -- a line
// that was only ever required at this `src/webmcp/tools/` layer (the story layer/`validate.ts`
// should still give the UI/internal callers the full message; neither of those is touched), so
// the fix converges into this new file: convert `Diagnostic[]` into a safe summary without
// `message`, shared by both tools in `./readonlyTools.ts` (readiness/inspect both need the same
// conversion, not rewritten a second time -- shared functionality is pulled into a reused
// component for the same kind of feature).
//
// The category (`DiagnosticCategory`) is a fixed enum safely derived from the **structure** of
// `path`, not by parsing the `message` string (`validate.ts` has no `code`/`type` field to borrow
// directly; `classifyPath()` below was exhaustively derived by going line by line through every
// `out.push()` call site currently in `validate.ts`). It **never extracts or returns any dynamic
// fragment** from path (a node id, choice id, state var name, or an unknown field name caught by
// `checkClosed()`) -- these fragments are YAML mapping keys the user names themselves inside
// story.yaml, and neither `validate.ts` nor `updateStoryStructure.ts` limits their character set
// or length (only `metadata.slug` is governed by `^[a-z0-9-]+$`; the chapterSlug in
// `docs/STORYSPEC.md` goes through a separate allowlist, `../../story/refs.ts`'s
// `CHAPTER_REF_RE` -- that's chapterSlug's world, not node id's world) -- it can't be treated as
// "allowlist-passed, safe to keep" the way `readiness.ts`'s summary treats chapterSlug, so
// `classifyPath()` only ever reads path's **position/depth** (`indexOf("/")`/`startsWith()`/
// `slice()`), never putting the dynamic fragment it sliced out into the return value itself.
import type { Diagnostic } from "../../contract/types.ts";

/** A fixed category enum -- maps one-to-one to the "shape" of each diagnostic-producing spot
 * currently in `validate.ts`, not its message text. Before adding a category, first confirm
 * `validate.ts` genuinely has a new path shape -- don't invent an unused member just because it
 * "sounds more precise." */
export type DiagnosticCategory =
  | "spec-version"
  | "kind"
  | "metadata"
  | "metadata-slug"
  | "start"
  | "ref-shape" // "must be shaped like { $ref }" for node content
  | "node-shape" // /nodes/<id> itself (an ending node with next/choices, a non-ending node missing next/choices, both next and choices present, an unreachable-node warning)
  | "dangling-next"
  | "choice-missing-target"
  | "dangling-target"
  | "unknown-field" // the core closed-field check (checkClosed) at any of the top-level/node/ending/choice layers
  | "other"; // a defensive catch-all -- if validate.ts ever grows a new path shape, it lands here instead of being missed or throwing

/** Classifies based only on path's structure (segment count, the position of fixed literal
 * segments) -- never slices out or returns any dynamic fragment (a node id/choice id/state var
 * name/unknown field name) itself, see the file header for why. */
export function classifyDiagnosticPath(path: string): DiagnosticCategory {
  if (path === "/specVersion") return "spec-version";
  if (path === "/kind") return "kind";
  if (path === "/metadata") return "metadata";
  if (path === "/metadata/slug") return "metadata-slug";
  if (path === "/start") return "start";

  if (path.startsWith("/nodes/")) {
    const afterNodes = path.slice("/nodes/".length); // what's left after "<id>" (could be empty)
    const idEnd = afterNodes.indexOf("/");
    const afterId = idEnd === -1 ? "" : afterNodes.slice(idEnd + 1); // skip past <id>, never use it itself

    if (afterId === "") return "node-shape";
    if (afterId === "content") return "ref-shape";
    if (afterId === "next") return "dangling-next";
    if (afterId.startsWith("ending/")) return "unknown-field";

    if (afterId.startsWith("choices/")) {
      const afterChoices = afterId.slice("choices/".length); // what's left after "<ck>"
      const ckEnd = afterChoices.indexOf("/");
      const afterChoice = ckEnd === -1 ? "" : afterChoices.slice(ckEnd + 1); // skip past <ck>

      if (afterChoice === "") return "choice-missing-target";
      if (afterChoice === "target") return "dangling-target";
      return "unknown-field"; // the choice layer's core closed-field check
    }

    return "unknown-field"; // the node layer's core closed-field check
  }

  // A top-level unknown field: the `/${k}` produced by checkClosed(spec, TOP_KEYS, false, "",
  // out) -- a single segment, and not any of the known fixed top-level fields above.
  if (/^\/[^/]+$/.test(path)) return "unknown-field";

  return "other";
}

export interface SafeDiagnosticCount {
  readonly category: DiagnosticCategory;
  readonly severity: "error" | "warning";
  readonly count: number;
}

export interface SafeDiagnosticsSummary {
  readonly errorCount: number;
  readonly warningCount: number;
  /** Counts grouped by (category, severity) -- no `message`, no dynamic fragment from path. An
   * empty array means this batch of diagnostics was itself empty (both errorCount/warningCount
   * are 0). */
  readonly categories: readonly SafeDiagnosticCount[];
}

/** `Diagnostic[]` -> a safe summary with no free text. `inspect_story`/`get_story_readiness`
 * share this one function, they don't each convert separately (see the file header). */
export function summarizeDiagnostics(diagnostics: readonly Diagnostic[]): SafeDiagnosticsSummary {
  let errorCount = 0;
  let warningCount = 0;
  const counts = new Map<string, SafeDiagnosticCount>();

  for (const d of diagnostics) {
    if (d.severity === "error") errorCount++;
    else warningCount++;

    const category = classifyDiagnosticPath(d.path);
    const key = `${category}:${d.severity}`;
    const existing = counts.get(key);
    if (existing) {
      counts.set(key, { ...existing, count: existing.count + 1 });
    } else {
      counts.set(key, { category, severity: d.severity, count: 1 });
    }
  }

  return { errorCount, warningCount, categories: [...counts.values()] };
}

/** Fixed wording for when `story.yaml`'s YAML syntax itself is illegal -- **never** carries the
 * original `Error.message` text thrown by the `yaml` package (2.9.0). Confirmed: `yaml@2.9.0`'s
 * `YAMLParseError.message` carries the raw original text around the offending line (e.g. `Tabs
 * are not allowed as indentation at line 4, column 3:\n\n<the offending line's original text>
 * \n...`) -- passing it through unchanged would mean sending the model whatever content happens
 * to be near the error location in story.yaml (which could be a whole block of body text), the
 * same shape of vulnerability as before, just with the trigger path swapped from "legal YAML but
 * a field filled in wrong" to "the YAML syntax itself is broken." */
export const INVALID_YAML_DETAIL =
  "story.yaml's YAML syntax is currently invalid (possibly an indentation, colon, quoting, or flow-collection syntax problem) -- fix the syntax error in the editor before it can be read again.";
