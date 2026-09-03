import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Note: the official "known issues" page for the Cloudflare Workers Vitest integration mentions
// that the older package (@cloudflare/vitest-pool-workers) has a limitation where "WebSocket +
// Durable Object tests don't support per-file storage isolation, and need
// --no-isolate --max-workers=1". This uses the newer package @cloudflare/vitest-plugin instead,
// which the wrangler CLI actively recommends now (see "choice of test setup" in
// relay/README.md) -- its cloudflareTest() options have no matching isolatedStorage/singleWorker
// switch. If that old limitation still exists under the new package, it should surface directly as
// a test failure/hang, not run silently wrong. This DO is zero-storage by design anyway (see the
// header of ../src/session-do.ts), so even if we really did hit the "per-file storage isolation"
// limitation, it wouldn't hurt us: there's no storage content that needs isolating between tests.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Overridden to short, test-friendly values (overriding wrangler.jsonc's production numbers),
      // so expiry/timeout tests finish within a second instead of really waiting several minutes or
      // 10 seconds:
      //   - PAIRING_TTL_MS: test/session-do.test.ts's "TTL expires before pairing ->
      //     session-expired". The idle and absolute TTLs share the same #endBySessionExpired()
      //     termination path, so testing the expiry of one TTL mechanism is already enough to prove
      //     that path itself is correct (the other two only differ in "when it's called", which is
      //     already covered by code review).
      //   - PRE_AUTH_TIMEOUT_MS: test/session-do.test.ts's "connects but never sends hello -> closed
      //     on timeout".
      // Both leave a generous buffer -- the other tests in the same test file that go from host
      // hello to a completed pairing are all WebSocket send/receive within the same process, and
      // should normally complete within single-digit milliseconds, so they shouldn't accidentally
      // collide with these two shortened windows.
      //
      // ALLOWED_ORIGIN is also overridden back to a local value here -- wrangler.jsonc's production
      // value is a placeholder string for the frontend's post-deploy URL (see the "Deploy"-related
      // comment in that file); tests shouldn't depend on that value, nor on whether .dev.vars exists
      // (that file is a git-ignored local-development file; a clean checkout won't have it, and
      // tests can't be built on the assumption that it exists).
      miniflare: { bindings: { PAIRING_TTL_MS: "800", PRE_AUTH_TIMEOUT_MS: "500", ALLOWED_ORIGIN: "http://localhost:5173" } },
    }),
  ],
});
