// smoke:build (package.json) -- runs after `vite build`, verifying the build output is observably
// correct:
//   1. dist/ exists and contains index.html.
//   2. dist/assets/*.js contains no string markers for the node runtime (mirroring the
//      source-code-level gate in scripts/check-boundary.ts, extending the same line to the build
//      output level too -- the source code not importing these things doesn't guarantee the build
//      output is necessarily clean, so it's worth verifying separately).
//   3. The chunks that dist/preview.html (the phone QR-code preview's
//      standalone entry point) actually loads -- computed by recursively following its own
//      <script type=module>/<link modulepreload> and the chunks' mutual import relationships to get
//      the full reachable set, not scanning all of dist/assets -- must contain none of
//      modelContext/registerTool/indexedDB/update_page_text. This is the mechanical proof, at the
//      build-output level, of the product requirement that "the preview entry has zero editor, zero
//      WebMCP": the import list discipline in src/preview/main.ts (only importing ./reader.ts +
//      ./relaySource.ts) is only a source-code-level self-constraint; what's verified here is that
//      "what actually got built" really doesn't bundle in ../ui/**/../webmcp/**/../adapters/**
//      together with it -- the source not importing something doesn't guarantee the bundler won't
//      accidentally pull it in through some path nobody noticed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.join(here, "..");
const DEFAULT_DIST_DIR = path.join(rootDir, "dist");

export interface RuntimeMarkerViolation {
  file: string;
  marker: string;
}

// The node runtime shouldn't leave any trace in the production bundle at all -- this app runs in
// the user's browser tab, where there's no node runtime available (see docs/architecture.md).
// `fake-indexeddb` is a test-only devDependency (used by the IndexedDB adapter's contract/reload/
// transaction-failure tests to simulate the browser's IndexedDB); the production adapter
// (src/adapters/indexeddbWorkspaceStorage.ts) only uses the browser's native `indexedDB` global,
// never importing this package -- it's added to this marker list to make sure it really wasn't
// accidentally bundled in by the build tooling.
// "node:" can't be used as a bare substring -- the yaml package's minified code contains an AST
// object literal like `{node:null}`, unrelated to Node.js but a false positive (hit this in
// practice). When a Node.js built-in module is actually bundled in, it always shows up as a quoted
// module specifier (`from"node:fs"`, `require("node:crypto")`, `import("node:path")`), so this only
// matches the shape "a quote immediately followed by node:".
const FORBIDDEN_SUBSTRINGS = ["fake-indexeddb"] as const;
const NODE_SPECIFIER_RE = /["'`]node:[a-z]/;

function walkJsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkJsFiles(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

// Scans the content of every .js file under assetsDir (default dist/assets), returning a list of
// violations containing forbidden markers. Returns an empty array when assetsDir doesn't exist
// (leaving it to the caller to decide whether "no assets directory" counts as another kind of
// failure).
export function scanDistForRuntimeMarkers(assetsDir: string): RuntimeMarkerViolation[] {
  const violations: RuntimeMarkerViolation[] = [];
  for (const file of walkJsFiles(assetsDir)) {
    const content = readFileSync(file, "utf8");
    for (const marker of FORBIDDEN_SUBSTRINGS) {
      if (content.includes(marker)) violations.push({ file, marker });
    }
    if (NODE_SPECIFIER_RE.test(content)) violations.push({ file, marker: 'node: module specifier (e.g. "node:fs")' });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// The preview.html entry's reachable chunk set + a forbidden-string scan
// ---------------------------------------------------------------------------

/** Strings that must never show up in the preview entry -- covering "WebMCP mounted" (modelContext/
 * registerTool, see the exact line in src/webmcp/facade.ts that actually calls
 * `document.modelContext.registerTool()`, not just a mention in a comment), "local workspace
 * storage" (indexedDB, see `globalThis.indexedDB` in src/adapters/indexeddbWorkspaceStorage.ts), and
 * "a write-category WebMCP tool's name" (update_page_text, see the tool's literal `name` in
 * src/webmcp/tools/writeTools.ts -- string constants in the build output aren't renamed by the
 * minifier). If even one of these four strings shows up in a chunk reachable from the preview
 * entry, that means the product line "zero editing / zero WebMCP" has broken down at the
 * build-output level. */
const PREVIEW_FORBIDDEN_SUBSTRINGS = ["modelContext", "registerTool", "indexedDB", "update_page_text"] as const;

function extractEntryScriptSrc(html: string): string | undefined {
  const match = /<script[^>]*type="module"[^>]*\ssrc="([^"]+)"/i.exec(html);
  return match?.[1];
}

function extractModulePreloadHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const re = /<link[^>]*rel="modulepreload"[^>]*\shref="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) hrefs.push(m[1]!);
  return hrefs;
}

// Inside a Rollup build output, the shape of chunks importing each other is a relative path in the
// same directory -- `import"./chunk-XXXX.js"` or `from"./chunk-XXXX.js"`. This recursively follows
// these imports, rather than only trusting the HTML's <link modulepreload> tags (Vite usually
// injects them, but this script's gate doesn't depend on that injection behavior staying the same --
// the recursive scan computes the reachable set itself, rather than assuming some side effect of the
// bundler will always exist).
// `\(?` makes the parenthesis between `import`/`from` and the quote
// optional -- an earlier version only recognized the two static shapes `import"./x.js"`/
// `from"./x.js"`, missing dynamic `import("./x.js")` (the call form, with an extra opening
// parenthesis right after `import` before the quote). Vite/Rollup always keeps a code-level
// `import()` dynamic import as a real runtime dynamic import (never inlining it into a static
// import), so this has to recognize that shape too -- otherwise a violating chunk pulled into the
// preview entry through a dynamic import (e.g. map/webmcp-related code accidentally loaded
// dynamically via some shared module) would be completely missed by this reachability scan, leaving
// `scanPreviewEntryForForbiddenMarkers()` only able to see the "statically reachable" subset, not
// the true, complete set of "what the browser will actually download and run once preview.html is
// opened".
function extractImportedChunkPaths(jsContent: string): string[] {
  const paths: string[] = [];
  const re = /(?:import|from)\s*\(?\s*["'](\.\/[^"']+\.js)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(jsContent))) paths.push(m[1]!);
  return paths;
}

/** The absolute paths of every .js chunk that dist/preview.html actually loads -- starting from its
 * own entry `<script>` and `<link modulepreload>` tags, recursively following the chunks' mutual
 * import relationships until it converges. Returns an empty array if `dist/preview.html` doesn't
 * exist (the build didn't treat it as a standalone entry). */
export function findPreviewEntryChunks(distDir: string): string[] {
  const previewHtmlPath = path.join(distDir, "preview.html");
  if (!existsSync(previewHtmlPath)) return [];
  const html = readFileSync(previewHtmlPath, "utf8");

  const entrySrc = extractEntryScriptSrc(html);
  if (!entrySrc) return [];

  const toAbs = (href: string) => path.join(distDir, href.replace(/^\//, ""));
  const seeds = [entrySrc, ...extractModulePreloadHrefs(html)].map(toAbs);

  const visited = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file) || !existsSync(file)) continue;
    visited.add(file);
    const content = readFileSync(file, "utf8");
    for (const rel of extractImportedChunkPaths(content)) {
      queue.push(path.resolve(path.dirname(file), rel));
    }
  }
  return [...visited];
}

/** Scans every chunk reachable from dist/preview.html, returning a list of violations containing
 * forbidden markers. Returns an empty array when preview.html doesn't exist (the caller decides
 * whether "the preview entry wasn't built" counts as another kind of failure). */
export function scanPreviewEntryForForbiddenMarkers(distDir: string): RuntimeMarkerViolation[] {
  const violations: RuntimeMarkerViolation[] = [];
  for (const file of findPreviewEntryChunks(distDir)) {
    const content = readFileSync(file, "utf8");
    for (const marker of PREVIEW_FORBIDDEN_SUBSTRINGS) {
      if (content.includes(marker)) violations.push({ file, marker });
    }
  }
  return violations;
}

function main() {
  const distDir = DEFAULT_DIST_DIR;
  const indexHtml = path.join(distDir, "index.html");

  if (!existsSync(distDir)) {
    console.error(`smoke:build failed -- can't find ${path.relative(process.cwd(), distDir)}; did the build run?`);
    process.exit(1);
  }
  if (!existsSync(indexHtml)) {
    console.error(`smoke:build failed -- no index.html under ${path.relative(process.cwd(), distDir)}`);
    process.exit(1);
  }

  const assetsDir = path.join(distDir, "assets");
  const violations = scanDistForRuntimeMarkers(assetsDir);
  if (violations.length) {
    console.error("smoke:build failed -- the production bundle contains a node runtime marker (see docs/architecture.md):");
    for (const v of violations) {
      console.error(`  ${path.relative(process.cwd(), v.file)}  contains the marker "${v.marker}"`);
    }
    process.exit(1);
  }

  const previewHtml = path.join(distDir, "preview.html");
  if (!existsSync(previewHtml)) {
    console.error(`smoke:build failed -- no preview.html under ${path.relative(process.cwd(), distDir)} (did vite.config.ts's multi-page input run?)`);
    process.exit(1);
  }
  const previewChunks = findPreviewEntryChunks(distDir);
  if (previewChunks.length === 0) {
    console.error("smoke:build failed -- preview.html has no reachable .js chunks, so zero-editor/zero-WebMCP can't be verified.");
    process.exit(1);
  }
  const previewViolations = scanPreviewEntryForForbiddenMarkers(distDir);
  if (previewViolations.length) {
    console.error("smoke:build failed -- a chunk reachable from the preview entry contains an editor/WebMCP marker (violates the \"zero editing / zero WebMCP\" requirement):");
    for (const v of previewViolations) {
      console.error(`  ${path.relative(process.cwd(), v.file)}  contains the marker "${v.marker}"`);
    }
    process.exit(1);
  }

  console.log(
    `smoke:build passed: ${path.relative(process.cwd(), distDir)} exists and contains index.html, and dist/assets/*.js has no node runtime markers.` +
      ` The preview entry reaches ${previewChunks.length} chunk(s) (${previewChunks.map((f) => path.relative(distDir, f)).join(", ")}),` +
      ` none containing modelContext/registerTool/indexedDB/update_page_text.`,
  );
}

// Only runs main() when executed directly as a script -- when imported by a test, only
// scanDistForRuntimeMarkers is used.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
