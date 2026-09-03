// Unit tests for the boundary checker (check-boundary.ts) itself -- proving it really does catch
// violations and really does let valid content through, rather than being decorative (see
// docs/architecture.md's "dependency boundary" requirement for automated checking).
//
// Feeds it violating/valid content via a temporary fixture directory, never committing a violating
// file into src. This test is a "workspace boundary" concern, and is classified under
// test:workspace (package.json).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanForViolations } from "./check-boundary.ts";

let tmpDir: string | undefined;

function makeFixture(files: Record<string, string>): string {
  tmpDir = mkdtempSync(path.join(tmpdir(), "storymaker-boundary-"));
  const srcDir = path.join(tmpDir, "src");
  mkdirSync(srcDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(srcDir, relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return srcDir;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("check-boundary scanForViolations", () => {
  it("flags node:fs / bare fs imports", () => {
    const srcDir = makeFixture({
      "bad.ts": `import { readFileSync } from "node:fs";\nreadFileSync("x");\n`,
      "bad2.ts": `import fs from "fs";\nfs.readFileSync("x");\n`,
    });
    const violations = scanForViolations(srcDir);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.specifier).sort()).toEqual(["fs", "node:fs"]);
  });

  it("flags other node builtins (e.g. node:path)", () => {
    const srcDir = makeFixture({
      "bad.ts": `import path from "node:path";\nconsole.log(path);\n`,
    });
    const violations = scanForViolations(srcDir);
    expect(violations).toHaveLength(1);
    expect(violations[0].specifier).toBe("node:path");
  });

  it("flags relative imports that escape the package", () => {
    const srcDir = makeFixture({
      "bad.ts": `import x from "../../outside.ts";\nconsole.log(x);\n`,
    });
    const violations = scanForViolations(srcDir);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/escapes/);
  });

  it("flags dynamic import() and require() of forbidden specifiers", () => {
    const srcDir = makeFixture({
      "bad.ts": `const f = await import("node:fs");\nconst c = require("node:crypto");\nconsole.log(f, c);\n`,
    });
    const violations = scanForViolations(srcDir);
    const specifiers = violations.map((v) => v.specifier).sort();
    expect(specifiers).toEqual(["node:crypto", "node:fs"]);
  });

  it("passes clean, in-package, browser-safe content", () => {
    const srcDir = makeFixture({
      "main.ts": `import { helper } from "./util.ts";\nconsole.log(helper());\n`,
      "util.ts": `export function helper() { return "ok"; }\n`,
    });
    const violations = scanForViolations(srcDir);
    expect(violations).toEqual([]);
  });

  it("passes imports of ordinary npm packages", () => {
    const srcDir = makeFixture({
      "main.ts": `import { z } from "zod";\nconsole.log(z);\n`,
    });
    const violations = scanForViolations(srcDir);
    expect(violations).toEqual([]);
  });
});
