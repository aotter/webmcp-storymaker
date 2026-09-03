import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

// A pure skeleton, no UI framework, no daemon proxy (see docs/architecture.md).
//
// A multi-page build -- `preview.html` (the phone QR-code preview's
// standalone entry point, src/preview/main.ts) and `index.html` (the creator side's main entry
// point) are two independent Rollup entry points, each recursively resolving its own import graph
// to produce matching chunks. This is exactly the precondition for scripts/smoke-build.ts to later
// "scan the chunks the preview entry actually bundled, proving none of them contain
// modelContext/registerTool/indexedDB/update_page_text" -- without this rollupOptions.input,
// preview.html would never be built as a standalone entry point at all.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        preview: fileURLToPath(new URL("./preview.html", import.meta.url)),
      },
    },
  },
  test: {
    // relay/ is an independent package (its own vitest.config.ts, running inside
    // @cloudflare/vitest-plugin's workerd sandbox, see "Preview relay" in relay/README.md), not part
    // of this web app. The root vitest's default **/*.test.ts glob would recursively pick up
    // relay/test/*.test.ts, and running those under this app's vitest (v3, jsdom/node environment,
    // with no cloudflare:test module) would crash outright -- explicitly excluded; relay's own
    // tests only run via `pnpm relay:test` (= relay/'s own vitest, inside its own directory).
    //
    // `**/.claude/**` (a real case confirmed on the
    // spot): the Agent tool's worktree isolation checks out the whole repo (relay/ included) into
    // `.claude/worktrees/<agent-id>/`, a folder that's neither tracked by git nor excluded by
    // gitignore (see git worktree list -- these are legitimate worktrees other Claude Code sessions
    // use to run review/verification agents in parallel, not garbage to clean up). The "relay/**"
    // entry above only blocks *this directory's* relay/, not the second copy of relay/ nested inside
    // a worktree -- so the same set of relay/test/*.test.ts would get recursively picked up a
    // second time, crashing again for lack of a cloudflare:test environment, and making `pnpm test`
    // FAIL falsely (this repo's own tests all still pass; what crashes is an unrelated nested
    // copy). Adding this wildcard exclusion means the root vitest never recurses into the whole
    // `.claude/` tree at all, no matter how many worktrees exist or under which agent id -- that
    // whole tree was never this repo's source code to begin with.
    exclude: [...configDefaults.exclude, "relay/**", "**/.claude/**"],
  },
});
