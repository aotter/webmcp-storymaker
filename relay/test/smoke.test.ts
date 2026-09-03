// A minimal test to verify the toolchain -- confirms @cloudflare/vitest-plugin can actually open a
// DO's WebSocket and send/receive one message round-trip, before writing the full behavior tests.
// If this test itself can't run (hangs/times out/throws an error related to WebSocket+DO
// isolation), that means the older limitation mentioned in the official docs (see the comment in
// ../vitest.config.ts) still exists in this package version, and a different approach is needed --
// report it.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateCredentials, nextMessage, openSocket, send } from "./ws-helpers.ts";

describe("smoke: DO WebSocket round-trip works under @cloudflare/vitest-plugin", () => {
  it("host hello gets a host-ready reply", async () => {
    const { hostKey, sid } = await generateCredentials();
    const stub = env.SESSION.getByName("smoke-test-session");
    const ws = await openSocket(stub, sid);
    send(ws, { type: "hello", role: "host", hostKey });
    const reply = await nextMessage(ws);
    expect(reply).toMatchObject({ type: "host-ready" });
  });
});
