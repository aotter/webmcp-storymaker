#!/usr/bin/env node
// Static check: relay/src must not contain any code that actually uses
// ctx.storage/state.storage, cache API writes, or a KV/R2/D1/Queue/Analytics Engine binding (see
// the "zero storage" note in ../src/session-do.ts's header). The only permitted hit is the
// comment in session-do.ts's own header explaining why these APIs aren't used -- outside of that,
// there should be zero hits. This also parses relay/wrangler.jsonc and asserts it declares none of
// these persistence-layer bindings (kv_namespaces/r2_buckets/d1_databases/queues/
// analytics_engine_datasets) -- it's not enough for the code to simply not call these APIs; if
// wrangler.jsonc itself declares one of these bindings, that means someone already intends to wire
// up a persistence layer, and that must be caught here too.
//
// This script is deliberately written as a plain Node script, run directly via `node`, not through
// vitest: test files running under @cloudflare/vitest-plugin run inside the workerd sandbox, and
// that environment isn't reliable for "reading the real file paths of the project's source tree"
// (tried using node:fs + import.meta.url to read files in that environment and hit a plain ENOENT
// from a path-encoding issue -- workerd's node:fs compatibility layer looks like it's meant for
// "reading virtual modules bundled into the worker", not for "scanning the project's source tree",
// which is what a dev-time static check like this needs). This check plays the same role in the
// relay as check-boundary.ts does in the main repo: it's a dev-time tool, not worker runtime code,
// so reading files directly with Node is entirely reasonable.
//
// relay/package.json's "test" script runs this script first, then vitest -- `pnpm relay:test` only
// passes once both are green.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RELAY_ROOT = path.join(here, "..");
const SRC_DIR = path.join(RELAY_ROOT, "src");

/** Blocks more than just the word "storage" -- alarm/KV/R2/D1/Queue/Analytics Engine are all other
 * forms of persistence layer or billing side effect, and equally violate the zero-storage rule.
 * The `\b`/`\(` boundaries exist so that "Queue" appearing inside an English word or phrase
 * unrelated to a persistence layer (e.g. if "message queue" as a generic term is ever written in
 * the future) doesn't automatically count as a violation -- but this script's guiding principle is
 * to over-block rather than let something slip through: if something really does trip this from an
 * unrelated English word, just add a documented exception (following the DOCUMENTED_EXCEPTION_*
 * constants below), don't loosen the pattern itself. */
const FORBIDDEN_PATTERN = /storage|caches\b|KVNamespace|R2Bucket|D1Database|setAlarm|\balarm\(|Queue\b|AnalyticsEngine/i;

/** The "zero storage" explanation in session-do.ts's header -- the only place allowed to match
 * FORBIDDEN_PATTERN. Uses a line-number range rather than comparing text line by line, so the
 * whole block still counts as long as it stays within this window when the header is rewritten.
 * Remember to update this number whenever session-do.ts's header length changes (the sanity check
 * below fails loudly if you forget and the number ends up too small). */
const DOCUMENTED_EXCEPTION_FILE = "session-do.ts";
const DOCUMENTED_EXCEPTION_LAST_LINE = 86;

/** The zero-storage rule also forbids wrangler.jsonc from declaring any kind of persistence-layer
 * binding. */
const FORBIDDEN_WRANGLER_KEYS = ["kv_namespaces", "r2_buckets", "d1_databases", "queues", "analytics_engine_datasets"];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Strips JSONC's `//` and `/* *‍/` comments, then JSON.parse -- a naive whole-text regex
 * replacement won't do (a URL string in wrangler.jsonc, e.g. "https://...", also contains "//",
 * and a naive replacement would chop off part of the string content thinking it's a comment).
 * Scans character by character, tracking whether we're currently inside a string (including
 * escape-character handling), and only recognizes the start of a comment outside of a string. */
function parseJsonc(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // Stop at the '*' so the next loop's i++ skips past the closing '/'
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

function checkNoForbiddenSourceUsage() {
  const hits = [];
  for (const file of walk(SRC_DIR)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, idx) => {
      if (!FORBIDDEN_PATTERN.test(text)) return;
      const line = idx + 1;
      const isDocumentedException = path.basename(file) === DOCUMENTED_EXCEPTION_FILE && line <= DOCUMENTED_EXCEPTION_LAST_LINE;
      if (!isDocumentedException) hits.push({ file: path.relative(SRC_DIR, file), line, text: text.trim() });
    });
  }

  // Sanity check: confirm the "one and only permitted exception window" still actually contains
  // text that matches the pattern -- not that the line number was set too small and let a real hit
  // slip through unnoticed too.
  const exceptionFile = path.join(SRC_DIR, DOCUMENTED_EXCEPTION_FILE);
  const exceptionLines = readFileSync(exceptionFile, "utf8").split("\n");
  const windowHasMatch = exceptionLines.slice(0, DOCUMENTED_EXCEPTION_LAST_LINE).some((l) => FORBIDDEN_PATTERN.test(l));
  if (!windowHasMatch) {
    console.error(
      `check-no-storage: sanity check failed — the documented-exception window (first ${DOCUMENTED_EXCEPTION_LAST_LINE} lines of ${DOCUMENTED_EXCEPTION_FILE}) no longer contains anything matching FORBIDDEN_PATTERN. The line-number window is stale — update DOCUMENTED_EXCEPTION_LAST_LINE.`,
    );
    process.exit(1);
  }

  if (hits.length > 0) {
    console.error("check-no-storage: FAILED — found undocumented persistence-related code in relay/src:");
    for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.text}`);
    process.exit(1);
  }

  return walk(SRC_DIR).length;
}

function checkWranglerConfigHasNoPersistenceBindings() {
  const configPath = path.join(RELAY_ROOT, "wrangler.jsonc");
  const config = parseJsonc(readFileSync(configPath, "utf8"));
  const present = FORBIDDEN_WRANGLER_KEYS.filter((key) => key in config);
  if (present.length > 0) {
    console.error(`check-no-storage: FAILED — wrangler.jsonc declares persistence bindings that violate the zero-storage decision: ${present.join(", ")}`);
    process.exit(1);
  }
}

function main() {
  const scanned = checkNoForbiddenSourceUsage();
  checkWranglerConfigHasNoPersistenceBindings();
  console.log(`check-no-storage: passed — zero undocumented persistence-related code in relay/src (${scanned} files scanned), and wrangler.jsonc declares no persistence bindings.`);
}

main();
