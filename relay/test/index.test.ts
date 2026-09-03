// Tests for ../src/index.ts (the Worker routing layer) -- the health endpoint, Origin access
// control, sid routing. Tests for the DO's own protocol state machine are in
// ./session-do.test.ts; this file only tests "should this request be accepted, and where should it
// be forwarded". Uses SELF.fetch() to hit the real Worker entry point (see `main` in
// ../wrangler.jsonc), not calling the DO stub directly.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateCredentials, nextClose, nextMessage } from "./ws-helpers.ts";

const ALLOWED_ORIGIN = "http://localhost:5173"; // Matches the test override value in ../vitest.config.ts

describe("/health", () => {
  it("returns a constant JSON body regardless of Origin", async () => {
    const res = await SELF.fetch("http://relay.example/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "webmcp-storymaker-preview-relay" });
  });

  it("rejects non-GET methods", async () => {
    const res = await SELF.fetch("http://relay.example/health", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("echoes Access-Control-Allow-Origin only when Origin matches ALLOWED_ORIGIN", async () => {
    const matching = await SELF.fetch("http://relay.example/health", { headers: { Origin: ALLOWED_ORIGIN } });
    expect(matching.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);

    const mismatched = await SELF.fetch("http://relay.example/health", { headers: { Origin: "https://evil.example" } });
    expect(mismatched.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("unknown routes", () => {
  it("404s anything other than /session and /health", async () => {
    const res = await SELF.fetch("http://relay.example/nope");
    expect(res.status).toBe(404);
  });
});

describe("/session — Origin access control", () => {
  it("rejects a WebSocket upgrade whose Origin does not match ALLOWED_ORIGIN, before any DO is involved", async () => {
    const res = await SELF.fetch("http://relay.example/session?sid=" + "a".repeat(64), {
      headers: { Upgrade: "websocket", Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(res.webSocket).toBeNull();
  });

  it("rejects a non-WebSocket request to /session even with a matching Origin", async () => {
    const res = await SELF.fetch("http://relay.example/session?sid=" + "a".repeat(64), {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(426);
  });
});

describe("/session — sid routing", () => {
  it("a missing sid completes the handshake itself and sends invalid-token, no DO involved", async () => {
    const res = await SELF.fetch("http://relay.example/session", {
      headers: { Upgrade: "websocket", Origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    expect(ws).not.toBeNull();
    ws!.accept();
    expect(await nextMessage(ws!)).toEqual({ type: "error", code: "invalid-token" });
    expect((await nextClose(ws!)).code).toBe(4004);
  });

  it("a malformed sid (wrong shape, not 64 lowercase hex chars) is also rejected as invalid-token", async () => {
    const res = await SELF.fetch("http://relay.example/session?sid=not-a-hash", {
      headers: { Upgrade: "websocket", Origin: ALLOWED_ORIGIN },
    });
    const ws = res.webSocket!;
    ws.accept();
    expect(await nextMessage(ws)).toEqual({ type: "error", code: "invalid-token" });
  });

  it("a well-formed sid routes through to a real SessionDO — full pipeline smoke test", async () => {
    const { hostKey, sid } = await generateCredentials();
    const res = await SELF.fetch(`http://relay.example/session?sid=${sid}`, {
      headers: { Upgrade: "websocket", Origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ type: "hello", role: "host", hostKey }));
    const reply = await nextMessage(ws);
    expect(reply).toMatchObject({ type: "host-ready" });

    // A second connection with the same sid should land on the same DO instance -- proves the
    // routing is consistent by relying on "a second host is rejected", a behavior that only shows
    // up when it's really the same DO.
    const secondRes = await SELF.fetch(`http://relay.example/session?sid=${sid}`, {
      headers: { Upgrade: "websocket", Origin: ALLOWED_ORIGIN },
    });
    const secondWs = secondRes.webSocket!;
    secondWs.accept();
    secondWs.send(JSON.stringify({ type: "hello", role: "host", hostKey }));
    expect(await nextMessage(secondWs)).toEqual({ type: "error", code: "protocol-violation" });
  });
});
