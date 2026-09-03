// Dependency boundary check (see docs/architecture.md): scans src/**'s import/require statements
// and rejects:
//   - Node.js built-in modules (`fs`/`node:fs` and any other `node:*` -- this app runs in the
//     browser, where there's no node runtime available)
//   - a relative path that escapes the src directory (rejected regardless of where it escapes to)
//
// This script itself is a Node tool (run via tsx, never entering the Vite build), so using node:fs
// to read files is fine -- the boundary governs "code under src that gets bundled into the browser
// build", not the scanning tool itself.
//
// A simple string/regex scan, with no dependency-graph framework pulled in -- the boundary itself
// requires this (the scan logic must be simple enough to trust at a glance).
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.join(here, "..");
const DEFAULT_TARGET_DIR = path.join(rootDir, "src");

export interface Violation {
  file: string;
  line: number;
  specifier: string;
  reason: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

// Matches: import ... from "spec"; export ... from "spec"; bare import "spec";
// require("spec"); and dynamic import("spec").
const IMPORT_RE = /(?:^|\s)(?:import|export)(?:\s+type)?\s+(?:[^'";]*\sfrom\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /import\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;

function checkSpecifier(specifier: string, fromFile: string, scanRoot: string): string | null {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  if (isBuiltin(bare) || isBuiltin(specifier)) {
    return "Node.js built-in modules are forbidden (the code runs in the browser, with no node runtime available)";
  }

  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(fromFile), specifier);
    if (resolved !== scanRoot && !resolved.startsWith(scanRoot + path.sep)) {
      return `a relative path escapes the ${path.relative(rootDir, scanRoot) || "."} directory`;
    }
  }

  return null;
}

// Scans the imports of every file under targetDir (default src), returning a list of violations.
// scanRoot is the boundary directory that "must not be escaped" -- defaults to targetDir itself
// (i.e. src), so tests can feed in a temporary fixture directory while following the exact same
// rule.
export function scanForViolations(targetDir: string, scanRoot: string = targetDir): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(targetDir)) {
    const src = readFileSync(file, "utf8");
    for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const specifier = m[1];
        const reason = checkSpecifier(specifier, file, scanRoot);
        if (!reason) continue;
        const upTo = src.slice(0, m.index);
        const line = upTo.split("\n").length;
        violations.push({ file, line, specifier, reason });
      }
    }
  }
  return violations;
}

function main() {
  const violations = scanForViolations(DEFAULT_TARGET_DIR);

  if (violations.length) {
    console.error("src dependency boundary violations (see docs/architecture.md):");
    for (const v of violations) {
      console.error(`  ${path.relative(rootDir, v.file)}:${v.line}  import "${v.specifier}" — ${v.reason}`);
    }
    process.exit(1);
  }

  const scanned = walk(DEFAULT_TARGET_DIR).length;
  console.log(`dependency boundary check passed (${scanned} files scanned).`);
}

// Only runs main() when executed directly as a script -- when imported by a test, only
// scanForViolations is used.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
