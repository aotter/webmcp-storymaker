import type { Choice, Diagnostic, Node, StorySpec } from "./types.ts";
import { isContentRefForStory } from "./contentRef.ts";

const TOP_KEYS = new Set(["specVersion", "kind", "metadata", "start", "nodes"]);
const METADATA_KEYS = new Set(["slug"]);
const NODE_KEYS = new Set(["content", "next", "choices", "type", "ending"]);
const CHOICE_KEYS = new Set(["target"]);
const ENDING_KEYS = new Set(["endingId", "endingType"]);
const SLUG_RE = /^[a-z0-9-]+$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkClosed(value: unknown, allowed: ReadonlySet<string>, path: string, out: Diagnostic[]): void {
  if (!isObject(value)) {
    out.push({ severity: "error", path, message: "must be an object" });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) out.push({ severity: "error", path: `${path}/${key}`, message: `unknown field \"${key}\"` });
  }
}

function isRef(value: unknown): value is { $ref: string } {
  return isObject(value) && Object.keys(value).length === 1 && typeof value.$ref === "string" && value.$ref.length > 0;
}

function hasChoices(node: Node): boolean {
  return isObject(node.choices) && Object.keys(node.choices).length > 0;
}

/** Validate only the story shape the contest reader can actually render. */
export function validate(spec: StorySpec): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!isObject(spec)) return [{ severity: "error", path: "", message: "story spec must be an object" }];
  checkClosed(spec, TOP_KEYS, "", out);
  if (spec.specVersion !== "storymaker/v1alpha1") out.push({ severity: "error", path: "/specVersion", message: "expected storymaker/v1alpha1" });
  if (spec.kind !== "Story") out.push({ severity: "error", path: "/kind", message: "expected Story" });
  checkClosed(spec.metadata, METADATA_KEYS, "/metadata", out);
  if (!isObject(spec.metadata) || typeof spec.metadata.slug !== "string" || !SLUG_RE.test(spec.metadata.slug)) {
    out.push({ severity: "error", path: "/metadata/slug", message: "must match ^[a-z0-9-]+$" });
  }

  if (!isObject(spec.nodes)) {
    out.push({ severity: "error", path: "/nodes", message: "must be an object" });
    return out;
  }
  const nodes = spec.nodes as Record<string, Node>;
  if (Object.keys(nodes).length === 0) {
    out.push({ severity: "error", path: "/nodes", message: "must contain at least one page" });
  } else if (!spec.start || !nodes[spec.start]) {
    out.push({ severity: "error", path: "/start", message: "must identify an existing node" });
  }

  for (const [id, node] of Object.entries(nodes)) {
    const path = `/nodes/${id}`;
    checkClosed(node, NODE_KEYS, path, out);
    if (!isObject(node)) continue;
    if (!isRef(node.content) || !isContentRefForStory(node.content.$ref, spec.metadata?.slug)) {
      out.push({ severity: "error", path: `${path}/content`, message: "must reference this story's content://<slug>/chapters/<chapterSlug>#fragments/text" });
    }
    const ending = node.type === "ending";
    const choicesValue = node.choices;
    if (choicesValue !== undefined && !isObject(choicesValue)) out.push({ severity: "error", path: `${path}/choices`, message: "must be a non-empty object" });
    const usableChoices = hasChoices(node);
    if (choicesValue !== undefined && !usableChoices && isObject(choicesValue)) out.push({ severity: "error", path: `${path}/choices`, message: "must not be empty" });
    if (node.type !== undefined && node.type !== "ending") out.push({ severity: "error", path: `${path}/type`, message: "only ending is supported" });

    if (ending) {
      if (node.next !== undefined || node.choices !== undefined) out.push({ severity: "error", path, message: "ending node must not have next or choices" });
      checkClosed(node.ending, ENDING_KEYS, `${path}/ending`, out);
      if (!isObject(node.ending) || typeof node.ending.endingId !== "string" || node.ending.endingId.length === 0) out.push({ severity: "error", path: `${path}/ending/endingId`, message: "must be a non-empty string" });
      if (!isObject(node.ending) || node.ending.endingType !== "good") out.push({ severity: "error", path: `${path}/ending/endingType`, message: "only good is supported" });
    } else {
      if (node.ending !== undefined) out.push({ severity: "error", path: `${path}/ending`, message: "is only allowed on an ending node" });
      if ((node.next === undefined) === !usableChoices) out.push({ severity: "error", path, message: "non-ending node needs exactly one of next or non-empty choices" });
    }
    if (node.next !== undefined && (typeof node.next !== "string" || !nodes[node.next])) out.push({ severity: "error", path: `${path}/next`, message: "must target an existing node" });
    if (usableChoices) for (const [label, choice] of Object.entries(node.choices as Record<string, Choice>)) {
      const choicePath = `${path}/choices/${label}`;
      checkClosed(choice, CHOICE_KEYS, choicePath, out);
      if (!isObject(choice) || typeof choice.target !== "string" || !nodes[choice.target]) out.push({ severity: "error", path: `${choicePath}/target`, message: "must target an existing node" });
    }
  }

  const seen = new Set<string>();
  const queue = nodes[spec.start] ? [spec.start] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes[id];
    if (node.next && nodes[node.next]) queue.push(node.next);
    if (isObject(node.choices)) for (const choice of Object.values(node.choices) as Choice[]) if (nodes[choice.target]) queue.push(choice.target);
  }
  for (const id of Object.keys(nodes)) if (!seen.has(id)) out.push({ severity: "warning", path: `/nodes/${id}`, message: "unreachable node" });
  return out;
}
