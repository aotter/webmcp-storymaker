// Restricted write tools -- the first time an agent can actually write to a story
// through WebMCP.
//
// Location/dependency direction follows the header note in ./readonlyTools.ts: this file is its
// sibling, same directory (`src/webmcp/tools/`), same one-way dependency: story -> (consumed by)
// <- webmcp/tools -> webmcp/types. The three tools line up with the story layer's existing verbs,
// no extras, and don't bypass the story layer's own consistency guarantees:
//   - `create_story`  -> `../../story/createMinimalStory.ts`
//   - `update_story_structure` -> `../../story/updateStoryStructure.ts`
//   - `update_page_text` -> `../../story/updatePageText.ts`
// Every tool's `execute()` only does "validate the input shape -> call the matching story-layer
// function -> convert the story layer's returned discriminated union into a safe DTO." It never
// reads/writes storage itself and never composes its own OCC decision -- the sole arbiter of OCC
// is `storage.mutate()` (via the story layer); this file only translates the result, it never
// re-adjudicates it.
//
// Generation/consistency: this file holds no field that survives across an `await` -- no cache
// of "the last write result," no memory of "the current revision." `expectedRevision` is
// supplied entirely by
// the caller (the agent) on every call; the tool itself is a stateless pure adapter layer. The
// UI's OCC/epoch/interaction generation (../../ui/controller.ts) has zero coupling with this
// file -- after the agent's write succeeds, the UI's next save/hydrate naturally catches up
// through the existing conflict-reload mechanism (see the "eventually consistent" section in
// ../../../README.md).
//
// Data minimization:
//   - A success response only ever returns `{ ok: true, revision }` -- it does not echo the
//     slug/title/spec/chapterSlug/lang/text the caller just sent in. The caller already knows
//     what it sent; echoing it back has no information value and only opens another channel that
//     recites the user's own input.
//   - Every failure response goes through the `toSafe*Error()` conversion below and never passes
//     a story-layer error object through unchanged -- some story-layer fields
//     (`invalid-input.reason`, `chapter-not-found.chapterSlug`, `invalid-path.path`/`.reason`)
//     embed the caller's raw input verbatim into a string (this is the story layer's existing,
//     correct behavior toward the UI/internal callers -- see each file's source; the UI needs
//     these details to show a human), but the WebMCP boundary, like the read-only tools,
//     only ever exposes one of three provably-safe kinds of value (see the field x criterion
//     table at the end of this file).
import type { StorySpec } from "../../contract/types.ts";
import type { WorkspaceStoragePort } from "../../ports.ts";
import type { WorkspaceMutationError } from "../../workspace/types.ts";
import { MAX_TEXT_FILE_BYTES } from "../../workspace/limits.ts";
import { createMinimalStory, updatePageText, updateStoryStructure } from "../../story/index.ts";
import type { CreateMinimalStoryError, UpdatePageTextError, UpdateStoryStructureError } from "../../story/index.ts";
import { setPageImage, SET_PAGE_IMAGE_MAX_BYTES, type SetPageImageError } from "../../media/setPageImage.ts";
import type { WebMcpToolDefinition } from "../types.ts";
import { INVALID_YAML_DETAIL, summarizeDiagnostics, type SafeDiagnosticsSummary } from "./safeDiagnostics.ts";

// ---------- Shared: safe DTO for WorkspaceMutationError ----------
//
// All three tools' failure paths can ultimately land on `storage.mutate()`'s own
// WorkspaceMutationError (see ../../ports.ts / ../../workspace/types.ts) -- share one conversion
// instead of converting it separately in each tool (same precedent as ./safeDiagnostics.ts for
// Diagnostic[]).
//
// Per-field criteria (must be one of program constant / count / allowlist capture to count as
// safe -- see the table at the end of the file):
//   - `revision-conflict.expectedRevision`/`.actualRevision`: both are the workspace revision
//     counter, plain numbers, kept unchanged.
//   - For the other variants (`invalid-path`/`type-mismatch`/`size-exceeded`/`empty-batch`/
//     `batch-too-large`), the `path`/`reason` fields could in principle carry a fragment of the
//     caller's original path (e.g. the path built from update_page_text's chapterSlug, if it
///    triggers the hidden-segment branch of ../../workspace/paths.ts `reservedShapeReason()`,
//     the whole path segment gets embedded verbatim into `reason`) -- keep only the `type` closed
//     enum discriminant, drop every dynamic field.
export type SafeWorkspaceMutationError =
  | { readonly type: "revision-conflict"; readonly expectedRevision: number; readonly actualRevision: number }
  | { readonly type: "invalid-path" }
  | { readonly type: "type-mismatch" }
  | { readonly type: "size-exceeded" }
  | { readonly type: "empty-batch" }
  | { readonly type: "batch-too-large" };

function toSafeMutationError(error: WorkspaceMutationError): SafeWorkspaceMutationError {
  if (error.type === "revision-conflict") return error; // all three fields are a closed enum/numbers, safe as-is
  return { type: error.type };
}

// ---------- Shared: input shape validation (a backstop when the host doesn't do JSON-schema validation) ----------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Error thrown when the input doesn't match inputSchema's shape -- fixed wording, never embeds
 * the caller's raw value (this is "the agent didn't call it per the schema" itself, not a
 * story-layer business error, so it isn't expressed as an `ok:false` discriminated union --
 * `execute()` just rejects directly, matching the existing convention for `signal.aborted`, see
 * the `if (signal.aborted) throw ...` in ./readonlyTools.ts). */
function schemaViolation(toolName: string, expectation: string): Error {
  return new Error(`${toolName}: input does not match schema (${expectation})`);
}

// ---------- Spec input sanitization + execute-wide try/catch ----------
//
// Two gaps between the schema and execute, both reproduced with plain-JSON techniques (see the
// "neutralization verification" section in the test file below for the side-by-side):
//
//   A fail-closed gap: feeding `update_story_structure` syntactically legal but
//   wrong-shaped JSON like `nodes.<id> = null`/`choices.<key> = null` makes `story-contract`'s
//   `validate()` throw an uncaught `TypeError` while accessing a property on `null` (reproduced:
//   "Cannot convert undefined or null to object") -- this exception escapes straight to
//   `execute()`'s caller (the host), bypassing this file's red line that "every error branch
//   goes through a safe DTO" (a natural exception's `.message` was never reviewed for safety and
//   could in principle carry a fragment of the input). A deeply nested (plain JSON, no cycle
//   needed) spec also blows the call stack via recursion in `validate()`/`stringifyYaml()`,
//   throwing an uncaught `RangeError` (reproduced: at depth 2000 `stringifyYaml()` throws
//   "Maximum call stack size exceeded") -- another trigger path for the same class of problem.
//
//   A more serious gap -- writes silently go through, reads blow up: when a circular
//   object reaches the spec, `stringifyYaml()` (the `yaml` package) **tolerates** the cycle using
//   YAML anchors/aliases -- reproduced: `stringify()` doesn't throw, the resulting YAML expresses
//   the cycle with `&a1`/`*a1`, and after `parse()` reads it back, `parsed.nodes.n.selfRef ===
//   parsed` is true -- a genuinely circular object. That means the `updateStoryStructure()` call
//   itself **succeeds** (`ok: true`) and the story gets persisted -- the real blowup happens
//   *afterward*: `../../story/refs.ts`'s `walkForChapterSlugs()` is a general-purpose recursive
//   scan over anything under `spec.nodes` with no
//   visited-set and no depth cap. `update_page_text` (via `collectReferencedChapterSlugs()`
//   validating chapterSlug), `inspect_story`, and `get_story_readiness` (the read-only tools,
//   all of which indirectly call the same function) all recurse into this already-persisted
//   circular structure on their next call and blow the stack -- this isn't a flaw in those
//   read-only tools themselves (they're reading a structure that genuinely exists in the
//   workspace right now; they shouldn't have to expect a cycle inside spec.nodes, which is
//   something no legal grammar could ever produce). The real gap is that
//   `update_story_structure` never held the line of "reject any shape that no legal StorySpec
//   could ever take."
//
// The fix uses two layers of defense, neither optional --
// layer 1 alone can't stop the null-property-access-style error, layer 2 alone can't stop
// the "doesn't throw at write time, blows up later" gap:
//
//   Layer 1 (`sanitizeSpecInput()`, used only in `update_story_structure`, runs before calling
//   the story layer):
//     1. Depth check (`exceedsMaxDepth()`) -- runs **first**, and must precede any serialization
//        attempt, because `JSON.stringify()` itself can also throw a `RangeError` on nesting deep
//        enough (V8's tolerance for depth isn't a stable guarantee -- it's affected by how much
//        call-stack space remains at the time, and you can't assume it's always more
//        stack-tolerant than the `yaml` package's `stringify()` -- reproduced: at depth 2000, a
//        non-circular case, `JSON.stringify()` didn't throw, but that's just this test
//        environment having enough remaining stack headroom, not a language guarantee).
//        `exceedsMaxDepth()` is implemented with **bounded** recursion: `remaining` decrements by
//        one on each level down, and returns immediately once `remaining < 0` (regardless of
//        whether the value is actually circular) -- this function calls itself at most
//        `MAX_SPEC_DEPTH + 1` levels deep and is guaranteed to return for any input shape (deep
//        nesting or a cycle), so the function itself can never stack-overflow. **This is also a
//        natural detector for circular references**: a circular object looks, to this bounded
//        recursion, exactly like "depth exceeds the cap" -- no need to also maintain a
//        visited-set for genuine cycle detection. The depth cap kills two birds with one stone,
//        blocking both the deep-nesting case and the circular-reference case without a separate branch
//        of logic for cycles. The depth cap is set to 64 (named constant `MAX_SPEC_DEPTH`): the
//        deepest nesting chain a legal StorySpec can have (node -> choices -> choice ->
//        requires/effects -> nested condition all/any) is, by hand, far below this number
//        (single to low double digits), so 64 leaves generous headroom while still staying well
//        below any depth that would actually strain V8's call stack (per the "reproduced" note
//        above, it takes depth 2000 to blow up -- 64 has more than 30x safety margin). We chose
//        "check level by level" over "use the serialized string length as a proxy for depth"
//        because the latter is imprecise (string length is affected by field count/string content
//        length, not a reliable proxy for nesting depth -- it could wrongly flag a genuinely deep
//        but field-sparse structure, or wrongly pass a shallow but content-heavy legal structure).
//        Level-by-level checking is the only way to precisely measure "nesting depth" itself, and
//        as noted above it's inherently stack-safe.
//     2. Serialized size cap (`MAX_SPEC_JSON_BYTES`) -- reuses `../../workspace/limits.ts`'s
//        `MAX_TEXT_FILE_BYTES` (story.yaml's own per-file cap is already governed by it) instead
//        of inventing a new independent number: the spec eventually gets written to story.yaml
//        via `stringifyYaml()`, so it can never legally be bigger than that cap. Enforcing the
//        same cap at this earlier boundary (before entering the story layer) avoids carrying a
//        payload that's already destined to be rejected by `mutate()` through a whole round of
//        `validate()`/`stringifyYaml()` first.
//     3. `JSON.parse(JSON.stringify(spec))` sanitization, wrapped in try/catch -- this step is a
//        second layer of insurance (the depth check has already blocked cycles, so in theory we
//        shouldn't hit a cycle-related exception here), and it also strips getters/class
//        instances/prototype pollution, leaving only plain data, and incidentally blocks
//        non-serializable values like `BigInt` that make `JSON.stringify` itself throw. Any
//        failure at any step (throws, or the serialized result is `undefined`, e.g. `spec` itself
//        is a function/symbol) fails closed with a fixed category, `invalid-spec-shape` -- never
//        passing through any exception message.
//
//   Layer 2 (inside `execute()`, wraps all three tools, last line of defense, does not replace
//   layer 1): the story-layer call is wrapped in try/catch, and any unexpected exception (e.g.
//   the `nodes.<id>=null` shape, which layer 1's sanitization can't block but which makes
//   `validate()` blow up on a null property access) is always classified as fixed
//   `internal-error`, **without the exception's `.message`** -- a native exception message has
//   never been reviewed for safety and could carry a fragment of the input (a property name, a
//   piece of `JSON.stringify()` output ...); passing it through would just bypass the whole
//   file's "every error branch goes through a safe DTO" criterion. All three tools' failure
//   fingerprints therefore always converge on `{ type: "internal-error" }`, without distinguishing
//   the kind of underlying exception -- the caller only needs to know "this operation failed, the
//   workspace is unchanged (the story-layer functions below never call `storage.mutate()` before
//   throwing -- see each function's source for the call order)," it doesn't need exception details
//   to decide what to do next (call inspect_story again to check the current state).

/** Depth cap for the spec JSON `update_story_structure` receives -- see the "Spec input
 * sanitization + execute-wide try/catch" note above. A legal StorySpec is far below this number; a circular reference
 * and abnormally deep nesting look identical to this bounded recursion as "over the cap," and
 * both are naturally blocked together. */
export const MAX_SPEC_DEPTH = 64;

/** Byte cap for the serialized spec `update_story_structure` receives -- reuses
 * ../../workspace/limits.ts's MAX_TEXT_FILE_BYTES (story.yaml itself is governed by it, see the
 * note above for why). */
export const MAX_SPEC_JSON_BYTES = MAX_TEXT_FILE_BYTES;

/** Bounded-recursion depth check -- see the "Spec input sanitization + execute-wide try/catch" note above:
 * `remaining` decrements by one on each level down and returns immediately once `remaining < 0`,
 * so this function calls itself at most `MAX_SPEC_DEPTH + 2` levels deep and is guaranteed to
 * return for any input (including a circular object) -- inherently stack-safe, while also
 * classifying a circular reference as "depth over the cap" without needing to also maintain a
 * visited-set. */
function exceedsMaxDepth(value: unknown, remaining: number): boolean {
  if (remaining < 0) return true;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (exceedsMaxDepth(item, remaining - 1)) return true;
    }
    return false;
  }
  for (const key of Object.keys(value)) {
    if (exceedsMaxDepth((value as Record<string, unknown>)[key], remaining - 1)) return true;
  }
  return false;
}

/** Spec input sanitizer used only by `update_story_structure` -- see the "Spec input
 * sanitization + execute-wide try/catch" note above. On success, the returned `value` is guaranteed to be depth-bounded
 * plain JSON data that round-trips fully through `JSON.stringify`, with no getter/class
 * instance/prototype pollution (whether it is a *legal* StorySpec is still decided by the
 * `validate()` the caller runs next -- this function is only responsible for "the shape is safe,"
 * not semantic validation). */
function sanitizeSpecInput(spec: unknown): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  // The whole function is wrapped in try/catch (review finding P2): both the depth walk and
  // JSON.stringify can trigger an enumerable getter -- if a malicious getter throws, and the
  // exception escapes this function, it bypasses the safe DTO and lets the getter's own message
  // out. The sanitization layer must converge to {ok:false} for "any shape of unknown input,"
  // never letting the input's own code decide our error path.
  try {
    // The depth check must precede any serialization attempt -- as noted above, JSON.stringify
    // itself can also throw on deep-enough nesting, so we can't assume it's always more
    // stack-tolerant than the yaml package's stringify.
    if (exceedsMaxDepth(spec, MAX_SPEC_DEPTH)) return { ok: false };

    const result = JSON.stringify(spec);
    if (result === undefined) return { ok: false }; // spec itself is undefined/function/symbol
    if (new TextEncoder().encode(result).length > MAX_SPEC_JSON_BYTES) return { ok: false };

    // One round trip: strips getters/class instances/prototype pollution, leaving only plain data.
    return { ok: true, value: JSON.parse(result) };
  } catch {
    // A circular reference, a non-serializable value like BigInt, or a throwing getter on the
    // input -- all of these are, uniformly, an unsafe shape.
    return { ok: false };
  }
}

// ---------- create_story ----------

/** Safe DTO for `CreateMinimalStoryError` -- per-field criteria in the table at the end of the
 * file:
 *   - `workspace-not-empty.entryCount`: a plain number, the file count from `storage.list()`, safe.
 *   - `invalid-input.field`: a closed `"slug"|"title"` enum, safe; the original `.reason` field
 *     embeds the caller's raw input (e.g. via `JSON.stringify(input.slug)`, see
 *     ../../story/createMinimalStory.ts) and is not passed through.
 *   - `invalid-story-spec.diagnostics`: swapped for `SafeDiagnosticsSummary` (reusing
 *     ./safeDiagnostics.ts, which excludes `Diagnostic.message` free text).
 *   - `mutation-rejected.error`: swapped for `SafeWorkspaceMutationError`.
 *   - `internal-error`: the fixed category from the "Spec input sanitization + execute-wide
 *     try/catch" note above for any unexpected exception inside `execute()`, without the exception's message. */
export type SafeCreateStoryError =
  | { readonly type: "workspace-not-empty"; readonly entryCount: number }
  | { readonly type: "invalid-input"; readonly field: "slug" | "title" }
  | { readonly type: "invalid-story-spec"; readonly diagnostics: SafeDiagnosticsSummary }
  | { readonly type: "mutation-rejected"; readonly error: SafeWorkspaceMutationError }
  | { readonly type: "internal-error" };

export type CreateStoryToolResult = { readonly ok: true; readonly revision: number } | { readonly ok: false; readonly error: SafeCreateStoryError };

function toSafeCreateStoryError(error: CreateMinimalStoryError): SafeCreateStoryError {
  switch (error.type) {
    case "workspace-not-empty":
      return { type: "workspace-not-empty", entryCount: error.entryCount };
    case "invalid-input":
      return { type: "invalid-input", field: error.field };
    case "invalid-story-spec":
      return { type: "invalid-story-spec", diagnostics: summarizeDiagnostics(error.diagnostics) };
    case "mutation-rejected":
      return { type: "mutation-rejected", error: toSafeMutationError(error.error) };
  }
}

function createCreateStoryTool(storage: WorkspaceStoragePort, onMutated: (() => void) | undefined): WebMcpToolDefinition {
  return {
    name: "create_story",
    title: "Create a minimal story",
    description:
      "Create an English story in an empty workspace. slug uses lowercase letters, digits, and " +
      "hyphens; title cannot be blank. It creates a minimal one-page good ending. Use the returned " +
      "revision for the next write, then replace the structure, add page text, and add images. " +
      "Aim for about 5 pages with one branch and two different endings. Existing workspaces are " +
      "never overwritten.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Story identifier, ^[a-z0-9-]+$" },
        title: { type: "string", description: "Book title, must not be blank" },
      },
      required: ["slug", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input, { signal }): Promise<CreateStoryToolResult> {
      if (signal.aborted) throw signal.reason ?? new Error("create_story: aborted");
      if (!isPlainObject(input)) throw schemaViolation("create_story", "input must be an object");
      const { slug, title } = input;
      if (typeof slug !== "string" || typeof title !== "string") {
        throw schemaViolation("create_story", "slug/title must be strings");
      }

      // Layer 2 (see the note above) -- slug/title are
      // already plain strings (type-checked above), and the story layer has no known uncaught
      // exception path for plain-string input, but we still wrap this uniformly in try/catch,
      // for the same reason as update_page_text/update_story_structure: never assume "this tool
      // looks safe right now" -- any unexpected exception must go through a safe DTO, safety
      // shouldn't depend on ongoing manual auditing.
      try {
        const result = await createMinimalStory(storage, { slug, title });
        if (result.ok) {
          onMutated?.();
          return { ok: true, revision: result.revision };
        }
        return { ok: false, error: toSafeCreateStoryError(result.error) };
      } catch {
        return { ok: false, error: { type: "internal-error" } };
      }
    },
  };
}

// ---------- update_story_structure ----------

/** Safe DTO for `UpdateStoryStructureError` -- same criteria as above, plus two categories this
 * file itself produces at the WebMCP boundary (not part of the story layer's own error type):
 *   - `invalid-spec-shape`: `sanitizeSpecInput()` sanitization failed (depth over the cap /
 *     circular reference / serialized size over the cap / non-serializable value) -- see the
 *     "Spec input sanitization + execute-wide try/catch" note above.
 *   - `internal-error`: the fixed category for any unexpected exception inside `execute()`
 *     (the `nodes.<id>=null`/`choices.<key>=null` shapes, which sanitization can't block
 *     but which make `validate()` blow up on a null property access, are caught by this layer). */
export type SafeUpdateStoryStructureError =
  | { readonly type: "invalid-story-spec"; readonly diagnostics: SafeDiagnosticsSummary }
  | { readonly type: "mutation-rejected"; readonly error: SafeWorkspaceMutationError }
  | { readonly type: "invalid-spec-shape" }
  | { readonly type: "internal-error" };

export type UpdateStoryStructureToolResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly error: SafeUpdateStoryStructureError };

function toSafeUpdateStoryStructureError(error: UpdateStoryStructureError): SafeUpdateStoryStructureError {
  switch (error.type) {
    case "invalid-story-spec":
      return { type: "invalid-story-spec", diagnostics: summarizeDiagnostics(error.diagnostics) };
    case "mutation-rejected":
      return { type: "mutation-rejected", error: toSafeMutationError(error.error) };
  }
}

function createUpdateStoryStructureTool(storage: WorkspaceStoragePort, onMutated: (() => void) | undefined): WebMcpToolDefinition {
  return {
    name: "update_story_structure",
    title: "Update story structure",
    description:
      "Replace the complete structure. Use the revision returned by the last successful write; " +
      "inspect before the first write, after a conflict, or when current page ids are needed. " +
      "Use storymaker/v1alpha1, Story, metadata.slug, start, and nodes. Every node needs content " +
      "{ $ref: content://<slug>/chapters/<chapterSlug>#fragments/text }. A non-ending has exactly " +
      "one of next or non-empty choices; each choice is { target }, keyed by its reader label. An " +
      "ending has type: ending and ending: { endingId, endingType: good }, with no next or choices. " +
      "Unknown fields are rejected. This is a full replacement; preserve nodes you still need. Aim " +
      "for about 5 pages with one branch and two different endings.",
    inputSchema: {
      type: "object",
      properties: {
        expectedRevision: { type: "integer", minimum: 0, description: "Revision from the last successful write or inspect_story" },
        spec: { type: "object", description: "Complete closed StoryMaker structure" },
      },
      required: ["expectedRevision", "spec"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input, { signal }): Promise<UpdateStoryStructureToolResult> {
      if (signal.aborted) throw signal.reason ?? new Error("update_story_structure: aborted");
      if (!isPlainObject(input)) throw schemaViolation("update_story_structure", "input must be an object");
      const { expectedRevision, spec } = input;
      if (!isNonNegativeInteger(expectedRevision)) {
        throw schemaViolation("update_story_structure", "expectedRevision must be an integer >= 0");
      }
      if (!isPlainObject(spec)) {
        throw schemaViolation("update_story_structure", "spec must be an object");
      }

      // Layer 1 (see the note above) -- depth cap +
      // serialized size cap + JSON round-trip sanitization, blocking deep nesting/circular
      // references/non-serializable values before calling the story layer
      // (validate()/stringifyYaml()). A failure here always fails closed with no storage write
      // (the story-layer function hasn't been called yet at this point).
      const sanitized = sanitizeSpecInput(spec);
      if (!sanitized.ok) {
        return { ok: false, error: { type: "invalid-spec-shape" } };
      }

      // Layer 2 (last line of defense, does not replace
      // layer 1) -- layer 1 sanitization only handles "shape safety" (depth/size/serializability),
      // it can't block syntactically legal but semantically malformed JSON (e.g.
      // `nodes.<id> = null`) that makes validate() blow up on a null property access with an
      // uncaught exception. Any exception not anticipated here always converges to
      // internal-error, never passing through the exception's message.
      try {
        const result = await updateStoryStructure(storage, { expectedRevision, spec: sanitized.value as unknown as StorySpec });
        if (result.ok) {
          onMutated?.();
          return { ok: true, revision: result.revision };
        }
        return { ok: false, error: toSafeUpdateStoryStructureError(result.error) };
      } catch {
        return { ok: false, error: { type: "internal-error" } };
      }
    },
  };
}

// ---------- update_page_text ----------

/** Safe DTO for `UpdatePageTextError` -- per-field criteria in the table at the end of the file:
 *   - `story-not-found`: no fields, safe.
 *   - `invalid-yaml`: swapped for the fixed wording `INVALID_YAML_DETAIL` (same precedent as
 *     ./readonlyTools.ts -- never pass through the yaml parser's original text).
 *   - `workspace-busy`: `.reason` is a fixed template string composed by the story layer itself
 *     (it only carries the retry count, a constant, never any caller value -- same criterion as
 *     the "already verified safe" note in the header of ./readonlyTools.ts), kept unchanged.
 *   - `chapter-not-found`: **does not return `chapterSlug`** (the caller's raw input value, free
 *     text, see the import note at the top of this file) -- returns only `knownChapterSlugs` (the
 *     return value of `collectReferencedChapterSlugs()`, which only ever inserts values captured
 *     by `CHAPTER_REF_RE`'s capture group, same criterion as `get_editor_focus`'s `chapterSlug` in
 *     ./readonlyTools.ts, a natural allowlist). The caller already knows what chapterSlug it sent
 *     -- it doesn't need the tool to echo it back to confirm; it only needs to know what the
 *     legal list looks like so it can compare on its own.
 *   - `invalid-text`: `.reason` is always the same fixed literal string ("text must not be
 *     blank"), never varies with the input -- but this is still converged down to just `type`,
 *     dropping the `reason` field, because this field's "safety" currently relies only on a human
 *     manually cross-checking the source; converging to a fixed enum discriminant doesn't need
 *     that kind of ongoing auditing (the criterion is one of three, not manual audit-to-maintain
 *     safety).
 *   - `invalid-path`: `.path`/`.reason` can both carry a fragment of the path built from the
 *     caller's chapterSlug/lang (see the hidden-segment branch of
 *     ../../workspace/paths.ts `reservedShapeReason()`) -- keep only `type`.
 *   - `mutation-rejected`: swapped for `SafeWorkspaceMutationError`.
 *   - `internal-error`: the fixed category for any
 *     unexpected exception inside `execute()`, without the exception's message (see the "Spec
 *     input sanitization + execute-wide try/catch" note above; `update_page_text`'s `chapterSlug`/`lang`/`text`
 *     are all plain strings, already known not to trigger deep-nesting/circular-reference-style
 *     exceptions the way `update_story_structure`'s `spec` can, but this is still wrapped
 *     uniformly in try/catch as a final line of defense -- never assume "this tool looks safe
 *     right now"). */
export type SafeUpdatePageTextError =
  | { readonly type: "story-not-found" }
  | { readonly type: "invalid-yaml"; readonly detail: string }
  | { readonly type: "workspace-busy"; readonly detail: string }
  | { readonly type: "chapter-not-found"; readonly knownChapterSlugs: readonly string[] }
  | { readonly type: "invalid-text" }
  | { readonly type: "invalid-path" }
  | { readonly type: "mutation-rejected"; readonly error: SafeWorkspaceMutationError }
  | { readonly type: "internal-error" };

export type UpdatePageTextToolResult = { readonly ok: true; readonly revision: number } | { readonly ok: false; readonly error: SafeUpdatePageTextError };

function toSafeUpdatePageTextError(error: UpdatePageTextError): SafeUpdatePageTextError {
  switch (error.type) {
    case "story-not-found":
      return { type: "story-not-found" };
    case "invalid-yaml":
      return { type: "invalid-yaml", detail: INVALID_YAML_DETAIL };
    case "workspace-busy":
      return { type: "workspace-busy", detail: error.reason };
    case "chapter-not-found":
      return { type: "chapter-not-found", knownChapterSlugs: error.knownChapterSlugs };
    case "invalid-text":
      return { type: "invalid-text" };
    case "invalid-path":
      return { type: "invalid-path" };
    case "mutation-rejected":
      return { type: "mutation-rejected", error: toSafeMutationError(error.error) };
  }
}

function createUpdatePageTextTool(storage: WorkspaceStoragePort, onMutated: (() => void) | undefined): WebMcpToolDefinition {
  return {
    name: "update_page_text",
    title: "Update page text",
    description:
      "Write non-blank English text for an existing chapter at content/<chapterSlug>.en.txt. Use " +
      "the revision returned by the last successful write; inspect only before the first write, " +
      "after a conflict, or when current chapter ids are needed.",
    inputSchema: {
      type: "object",
      properties: {
        expectedRevision: { type: "integer", minimum: 0, description: "Revision from the last successful write or inspect_story" },
        chapterSlug: { type: "string", pattern: "^[a-z0-9-]+$", description: "A page identifier currently referenced by story.yaml" },
        lang: { type: "string", enum: ["en"], description: "Only en is supported; always pass \"en\"" },
        text: { type: "string", description: "The full page text, must not be blank" },
      },
      required: ["expectedRevision", "chapterSlug", "lang", "text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input, { signal }): Promise<UpdatePageTextToolResult> {
      if (signal.aborted) throw signal.reason ?? new Error("update_page_text: aborted");
      if (!isPlainObject(input)) throw schemaViolation("update_page_text", "input must be an object");
      const { expectedRevision, chapterSlug, lang, text } = input;
      if (!isNonNegativeInteger(expectedRevision)) {
        throw schemaViolation("update_page_text", "expectedRevision must be an integer >= 0");
      }
      if (typeof chapterSlug !== "string" || typeof lang !== "string" || typeof text !== "string") {
        throw schemaViolation("update_page_text", "chapterSlug/lang/text must be strings");
      }

      // Layer 2 (see the note above).
      try {
        const result = await updatePageText(storage, { expectedRevision, chapterSlug, lang, text });
        if (result.ok) {
          onMutated?.();
          return { ok: true, revision: result.revision };
        }
        return { ok: false, error: toSafeUpdatePageTextError(result.error) };
      } catch {
        return { ok: false, error: { type: "internal-error" } };
      }
    },
  };
}

// ---------- set_page_image ----------
//
// Once the agent generates an
// illustration, it supplies it directly as base64 and it lands with a single mutate(), with no
// step waiting for a human to approve. Implemented in ../../media/setPageImage.ts (the story
// layer's sibling file) -- this file only does "validate the input shape -> call setPageImage()
// -> converge on a safe DTO," same division of labor as the three tools above.
//
// Safe DTO criteria (same table as the three tools above):
//   - `story-not-found`/`invalid-yaml` (-> fixed wording)/`workspace-busy` (fixed template
//     reason, same criterion as ./readonlyTools.ts) -- shares the same ReadStoryError semantics
//     as update_page_text.
//   - `story-mismatch`: does not return `actualStorySlug` (when the caller's storySlug is wrong,
//     there's no need to echo back the workspace's real storySlug -- the agent only needs to know
//     "it doesn't match" and can call inspect_story again to check).
//   - `chapter-not-found`: same as update_page_text, returns only `knownChapterSlugs`.
//   - `invalid-base64`/`invalid-image`/`media-json-corrupt`: these `.reason` fields can all carry
//     a fragment of the caller's raw input (a base64 decode error message, a validation failure
//     reason) or environment details -- keep only `type`.
//   - `empty-image`/`unsupported-mime-type`/`hash-unavailable`: no fields -- `mimeType`
//     deliberately does **not** echo the caller's raw string: the `enum` in `inputSchema` is only
//     a contract for the agent to read, `execute()` actually only checks that it's a string (see
//     below), it isn't constrained by the enum, so the caller could pass in arbitrary text -- and
//     echoing it back would open a channel for leaking an arbitrary string (same "data
//     minimization" clause B as the header of this file).
//   - `image-too-large`: keeps the two plain numbers `byteLength`/`maxBytes` -- both are counts
//     the server computed itself, not an echo of the caller's string.
//   - `mutation-rejected`: swapped for `SafeWorkspaceMutationError`.
//   - `internal-error`: same existing line of defense as the three tools above.
export type SafeSetPageImageError =
  | { readonly type: "story-not-found" }
  | { readonly type: "invalid-yaml"; readonly detail: string }
  | { readonly type: "workspace-busy"; readonly detail: string }
  | { readonly type: "story-mismatch" }
  | { readonly type: "chapter-not-found"; readonly knownChapterSlugs: readonly string[] }
  | { readonly type: "invalid-base64" }
  | { readonly type: "empty-image" }
  | { readonly type: "image-too-large"; readonly byteLength: number; readonly maxBytes: number }
  | { readonly type: "unsupported-mime-type" }
  | { readonly type: "invalid-image" }
  | { readonly type: "hash-unavailable" }
  | { readonly type: "media-json-corrupt" }
  | { readonly type: "mutation-rejected"; readonly error: SafeWorkspaceMutationError }
  | { readonly type: "internal-error" };

export type SetPageImageToolResult = { readonly ok: true; readonly revision: number } | { readonly ok: false; readonly error: SafeSetPageImageError };

function toSafeSetPageImageError(error: SetPageImageError): SafeSetPageImageError {
  switch (error.type) {
    case "story-not-found":
      return { type: "story-not-found" };
    case "invalid-yaml":
      return { type: "invalid-yaml", detail: INVALID_YAML_DETAIL };
    case "workspace-busy":
      return { type: "workspace-busy", detail: error.reason };
    case "story-mismatch":
      return { type: "story-mismatch" };
    case "chapter-not-found":
      return { type: "chapter-not-found", knownChapterSlugs: error.knownChapterSlugs };
    case "invalid-base64":
      return { type: "invalid-base64" };
    case "empty-image":
      return { type: "empty-image" };
    case "image-too-large":
      return { type: "image-too-large", byteLength: error.byteLength, maxBytes: error.maxBytes };
    case "unsupported-mime-type":
      return { type: "unsupported-mime-type" };
    case "invalid-image":
      return { type: "invalid-image" };
    case "hash-unavailable":
      return { type: "hash-unavailable" };
    case "media-json-corrupt":
      return { type: "media-json-corrupt" };
    case "mutation-rejected":
      return { type: "mutation-rejected", error: toSafeMutationError(error.error) };
  }
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function createSetPageImageTool(storage: WorkspaceStoragePort, onMutated: (() => void) | undefined): WebMcpToolDefinition {
  return {
    name: "set_page_image",
    title: "Set page illustration",
    description:
      "Set or replace an existing page's illustration immediately. Send agent-provided base64, not " +
      "a URL. PNG, JPEG, and WebP are accepted up to 5 MiB. Use the revision returned by the last " +
      "successful write; inspect only before the first write, after a conflict, or when current " +
      "page ids are needed.",
    inputSchema: {
      type: "object",
      properties: {
        expectedRevision: { type: "integer", minimum: 0, description: "Revision from the last successful write or inspect_story" },
        storySlug: { type: "string", description: "The current story's slug (inspect_story's metadata.slug)" },
        chapterSlug: { type: "string", pattern: "^[a-z0-9-]+$", description: "A page identifier currently referenced by story.yaml" },
        imageBase64: { type: "string", description: "Image content, base64-encoded (without a data: URL prefix)" },
        mimeType: {
          type: "string",
          enum: ["image/png", "image/jpeg", "image/webp"],
          description: "Optional; when omitted, png/jpg/webp magic bytes are tried in order to detect the format",
        },
      },
      required: ["expectedRevision", "storySlug", "chapterSlug", "imageBase64"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    async execute(input, { signal }): Promise<SetPageImageToolResult> {
      if (signal.aborted) throw signal.reason ?? new Error("set_page_image: aborted");
      if (!isPlainObject(input)) throw schemaViolation("set_page_image", "input must be an object");
      const { expectedRevision, storySlug, chapterSlug, imageBase64, mimeType } = input;
      if (!isNonNegativeInteger(expectedRevision)) {
        throw schemaViolation("set_page_image", "expectedRevision must be an integer >= 0");
      }
      if (typeof storySlug !== "string" || typeof chapterSlug !== "string" || typeof imageBase64 !== "string") {
        throw schemaViolation("set_page_image", "storySlug/chapterSlug/imageBase64 must be strings");
      }
      if (!isOptionalString(mimeType)) {
        throw schemaViolation("set_page_image", "mimeType must be a string or omitted");
      }

      try {
        const result = await setPageImage(storage, { expectedRevision, storySlug, chapterSlug, imageBase64, mimeType });
        if (result.ok) {
          onMutated?.();
          return { ok: true, revision: result.revision };
        }
        return { ok: false, error: toSafeSetPageImageError(result.error) };
      } catch {
        return { ok: false, error: { type: "internal-error" } };
      }
    },
  };
}

// ---------- Factory ----------

export interface WriteToolsDeps {
  readonly storage: WorkspaceStoragePort;
  /** Called once after each tool's mutation actually
   * succeeds (`ok:true`) -- the composition root (../../main.ts) wires this to
   * `../../ui/controller.ts`'s `hydrate()`, so the screen updates automatically after the agent
   * writes through WebMCP, without the user having to press "refresh". Optional -- tests/callers with
   * no UI attached can skip it, and none of the four tools' core behavior depends on it; it's
   * purely a side-channel notification on success. Deliberately not called on a failure branch:
   * failure means the workspace didn't change, so there's nothing to refresh. */
  readonly onMutated?: () => void;
}

/** Same factory shape as ./readonlyTools.ts: a pure function factory -- the `../../app.ts`
 * composition root hands the returned definitions to the same `AppPorts.webMcp.registerTools()`
 * call as the read-only tools batch (see README's "eventual consistency" section). This file itself never
 * touches `document.modelContext`; it only handles the conversion from "story-layer write
 * capability" to "WebMcpToolDefinition shape" plus converging on safe DTOs. */
export function createWriteTools(deps: WriteToolsDeps): WebMcpToolDefinition[] {
  return [
    createCreateStoryTool(deps.storage, deps.onMutated),
    createUpdateStoryStructureTool(deps.storage, deps.onMutated),
    createUpdatePageTextTool(deps.storage, deps.onMutated),
    createSetPageImageTool(deps.storage, deps.onMutated),
  ];
}
