// Unit tests for smoke-build's production-bundle scanner -- proving it really does catch node
// runtime/fake-indexeddb markers, and really does let a clean build output through, rather than
// being decorative. Feeds it content via a temporary fixture directory, never touching the real
// dist/.
//
// This is a "build-output boundary" concern, following the same approach as
// check-boundary.workspace.test.ts, and is classified under test:workspace (package.json).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findPreviewEntryChunks, scanDistForRuntimeMarkers, scanPreviewEntryForForbiddenMarkers } from "./smoke-build.ts";

let tmpDir: string | undefined;

function makeAssetsFixture(files: Record<string, string>): string {
  tmpDir = mkdtempSync(path.join(tmpdir(), "storymaker-smoke-"));
  const assetsDir = path.join(tmpDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    writeFileSync(path.join(assetsDir, relPath), content, "utf8");
  }
  return assetsDir;
}

/** Simulates a `dist/` directory -- `preview.html` plus any number of
 * chunk files under `dist/assets/` -- for tests of findPreviewEntryChunks()/
 * scanPreviewEntryForForbiddenMarkers(), never touching the real dist/. Returns the absolute path
 * of this fake dist directory. */
function makeDistFixture(params: { previewHtml: string; assets: Record<string, string> }): string {
  tmpDir = mkdtempSync(path.join(tmpdir(), "storymaker-smoke-preview-"));
  const assetsDir = path.join(tmpDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(path.join(tmpDir, "preview.html"), params.previewHtml, "utf8");
  for (const [relPath, content] of Object.entries(params.assets)) {
    writeFileSync(path.join(assetsDir, relPath), content, "utf8");
  }
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("smoke-build scanDistForRuntimeMarkers", () => {
  it("flags a fake-indexeddb marker", () => {
    const assetsDir = makeAssetsFixture({
      "index-abc.js": `import "fake-indexeddb/auto";`,
    });

    const violations = scanDistForRuntimeMarkers(assetsDir);

    expect(violations).toHaveLength(1);
    expect(violations[0].marker).toBe("fake-indexeddb");
  });

  it("flags a node: module specifier", () => {
    const assetsDir = makeAssetsFixture({ "index-abc.js": `const x = "node:fs";` });

    const violations = scanDistForRuntimeMarkers(assetsDir);

    expect(violations.some((v) => v.marker.startsWith("node:"))).toBe(true);
  });

  it("does not false-positive on a bare node: object-literal key (the shape of the yaml package\u2019s minified code)", () => {
    const assetsDir = makeAssetsFixture({
      "index-abc.js": `const ast = {node:null, value:1}; const s = "anode:x";`,
    });

    expect(scanDistForRuntimeMarkers(assetsDir)).toHaveLength(0);
  });

  it("flags markers across multiple files, each reported separately", () => {
    const assetsDir = makeAssetsFixture({
      "a.js": `import "fake-indexeddb/auto";`,
      "b.js": `const n = "node:path";`,
    });

    const violations = scanDistForRuntimeMarkers(assetsDir);

    expect(violations).toHaveLength(2);
  });

  it("passes clean production-like bundle content", () => {
    const assetsDir = makeAssetsFixture({
      "index-abc.js": `console.log("StoryMaker entry skeleton");`,
    });

    const violations = scanDistForRuntimeMarkers(assetsDir);

    expect(violations).toEqual([]);
  });

  it("returns no violations when the assets dir does not exist", () => {
    const violations = scanDistForRuntimeMarkers(path.join(tmpdir(), `storymaker-does-not-exist-${Date.now()}`));

    expect(violations).toEqual([]);
  });
});

describe("smoke-build preview entry chunk scan", () => {
  it("returns no chunks when dist/preview.html does not exist", () => {
    const distDir = makeDistFixture({ previewHtml: "", assets: {} });
    rmSync(path.join(distDir, "preview.html"));

    expect(findPreviewEntryChunks(distDir)).toEqual([]);
    expect(scanPreviewEntryForForbiddenMarkers(distDir)).toEqual([]);
  });

  it("follows the entry <script> and recursively bundled chunk imports", () => {
    const distDir = makeDistFixture({
      previewHtml: `<script type="module" crossorigin src="/assets/preview-abc.js"></script>`,
      assets: {
        "preview-abc.js": `import "./chunk-def.js"; console.log("preview entry");`,
        "chunk-def.js": `console.log("shared reader chunk");`,
      },
    });

    const chunks = findPreviewEntryChunks(distDir).map((f) => path.basename(f)).sort();

    expect(chunks).toEqual(["chunk-def.js", "preview-abc.js"]);
  });

  it("also follows <link modulepreload> hrefs listed in the HTML", () => {
    const distDir = makeDistFixture({
      previewHtml:
        `<link rel="modulepreload" href="/assets/vendor-xyz.js">` +
        `<script type="module" crossorigin src="/assets/preview-abc.js"></script>`,
      assets: {
        "preview-abc.js": `console.log("preview entry");`,
        "vendor-xyz.js": `console.log("vendor chunk");`,
      },
    });

    const chunks = findPreviewEntryChunks(distDir).map((f) => path.basename(f)).sort();

    expect(chunks).toEqual(["preview-abc.js", "vendor-xyz.js"]);
  });

  it("flags modelContext/registerTool/indexedDB/update_page_text markers reachable from preview.html", () => {
    const distDir = makeDistFixture({
      previewHtml: `<script type="module" crossorigin src="/assets/preview-abc.js"></script>`,
      assets: {
        "preview-abc.js": `import "./chunk-leak.js"; console.log("preview entry");`,
        "chunk-leak.js": `modelContext.registerTool(x); globalThis.indexedDB; const n = "update_page_text";`,
      },
    });

    const violations = scanPreviewEntryForForbiddenMarkers(distDir);

    expect(violations.map((v) => v.marker).sort()).toEqual(["indexedDB", "modelContext", "registerTool", "update_page_text"]);
  });

  it("also follows chunks pulled in via a dynamic import(), not just static import/from", () => {
    const distDir = makeDistFixture({
      previewHtml: `<script type="module" crossorigin src="/assets/preview-abc.js"></script>`,
      assets: {
        "preview-abc.js": `import("./chunk-leak.js"); console.log("preview entry");`,
        "chunk-leak.js": `modelContext.registerTool(x);`,
      },
    });

    const chunks = findPreviewEntryChunks(distDir).map((f) => path.basename(f)).sort();
    expect(chunks).toEqual(["chunk-leak.js", "preview-abc.js"]);

    const violations = scanPreviewEntryForForbiddenMarkers(distDir);
    expect(violations.map((v) => v.marker).sort()).toEqual(["modelContext", "registerTool"]);
  });

  it("does not flag a marker that only appears in a chunk unreachable from preview.html", () => {
    const distDir = makeDistFixture({
      previewHtml: `<script type="module" crossorigin src="/assets/preview-abc.js"></script>`,
      assets: {
        "preview-abc.js": `console.log("preview entry, clean");`,
        // This chunk exists under dist/assets/, but is never imported by preview-abc.js -- it
        // shouldn't be scanned (this is exactly the point this test proves: the preview scan is a
        // "reachable set", not "all of dist/assets").
        "main-only.js": `modelContext.registerTool(x);`,
      },
    });

    expect(scanPreviewEntryForForbiddenMarkers(distDir)).toEqual([]);
  });

  it("passes a clean preview entry with no markers", () => {
    const distDir = makeDistFixture({
      previewHtml: `<script type="module" crossorigin src="/assets/preview-abc.js"></script>`,
      assets: {
        "preview-abc.js": `console.log("StoryMaker preview entry -- reader + relaySource placeholder only");`,
      },
    });

    expect(scanPreviewEntryForForbiddenMarkers(distDir)).toEqual([]);
  });
});
