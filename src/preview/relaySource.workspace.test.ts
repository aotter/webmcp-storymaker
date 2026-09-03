// RelaySource - feeds a sequence of messages through a fake WebSocket (see
// FakeWebSocket below) to prove the phone side's pairing/transfer/fail-closed validation logic
// is correct, without connecting to a real relay.
//
// The filename follows the existing convention from ../preview/localSource.workspace.test.ts
// and the like (the `.workspace.test.ts` suffix) - although this test never touches the
// IndexedDB workspace directly, everything under src/preview/ uses this suffix except
// ./protocol.test.ts (which has its own explicit reason, see that file's header); `pnpm test`
// itself doesn't look at the suffix and runs everything regardless, so the suffix is purely an
// existing classification convention.
//
// A technical constraint of import.meta.env (worth explaining up front, so the
// beforeAll/afterAll below don't look like pointless ceremony): `../relaySource.ts`'s
// `RELAY_URL` is a module-top-level const, read from `import.meta.env.VITE_PREVIEW_RELAY_URL`
// exactly once, the first time the module is imported - `vi.stubEnv()` changes what value shows
// up on later reads of `import.meta.env`, and has no retroactive effect on a module that's
// already been imported and already computed its constant. So this file calls `vi.stubEnv()`
// **before** importing ./relaySource.ts, and uses `vi.resetModules()` + a dynamic `import()` to
// guarantee it gets a fresh module instance whose constant was recomputed against the new
// environment variable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateHostKey } from "./protocol.ts";
import type { PreviewSnapshot } from "./snapshot.ts";
import type { PreviewSourceStatus } from "./source.ts";

// ---------------------------------------------------------------------------
// FakeWebSocket - the minimal usable fake WebSocket; events are fed in by manually calling
// simulateXxx(), and it never touches a real network.
// ---------------------------------------------------------------------------
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  #listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (event: unknown) => void): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(cb);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.#dispatch("close", {});
  }

  #dispatch(type: string, event: unknown): void {
    for (const cb of this.#listeners.get(type) ?? new Set()) cb(event);
  }

  // ---- Test-only event simulation ----
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.#dispatch("open", {});
  }

  simulateMessage(payload: unknown): void {
    this.#dispatch("message", { data: JSON.stringify(payload) });
  }

  simulateClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.#dispatch("close", {});
  }
}

async function waitForSocket(): Promise<FakeWebSocket> {
  const socket = await vi.waitUntil(() => FakeWebSocket.instances.at(-1), { timeout: 1000, interval: 5 });
  return socket;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const VALID_SNAPSHOT: PreviewSnapshot = {
  story: {
    title: "Sample Story",
    startPageId: "p1",
    pages: [{ id: "p1", text: "Once upon a time", imageId: "img-a", choices: [] }],
  },
  images: [
    { id: "img-a", mime: "image/png", byteLength: 4 },
    { id: "img-b", mime: "image/png", byteLength: 3 },
  ],
  revision: 1,
};

let RelaySource: typeof import("./relaySource.ts").RelaySource;

async function freshRelaySourceModule(relayUrl: string | undefined): Promise<void> {
  // `vi.stubEnv(name, undefined)` (rather than `vi.unstubAllEnvs()`) - testing shows that
  // `unstubAllEnvs()` does not make a subsequently re-imported module actually see undefined,
  // given this file's call sequence (likely an interaction between vite-node's module cache and
  // stub-restoration timing, not behavior this test is meant to verify); passing `undefined`
  // into `stubEnv()` explicitly is the only reliable way every time.
  vi.stubEnv("VITE_PREVIEW_RELAY_URL", relayUrl);
  vi.resetModules();
  ({ RelaySource } = await import("./relaySource.ts"));
}

describe("RelaySource", () => {
  const token = generateHostKey(); // A 43-character base64url string - the same shape as VIEWER_TOKEN_PATTERN, good enough to feed a test that only exercises "the local side's behavior"; it doesn't need to actually be a value hashed from some real hostKey.

  beforeEach(async () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal("location", { hash: `#t=${token}`, pathname: "/preview.html", search: "", origin: "https://example.test" });
    vi.stubGlobal("history", { replaceState: vi.fn() });
    await freshRelaySourceModule("ws://relay.test");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("happy path: manifest + two images' worth of chunks + complete -> load() succeeds, image() can read the bytes", async () => {
    const source = new RelaySource();
    const statuses: PreviewSourceStatus[] = [];
    source.onStatus((s) => statuses.push(s));

    const loadPromise = source.load();
    const ws = await waitForSocket();
    expect(ws.url).toBe(`ws://relay.test/session?sid=${await (await import("./protocol.ts")).deriveSid(token)}`);

    ws.simulateOpen();
    expect(ws.sent).toEqual([{ type: "hello", role: "viewer", token }]);

    ws.simulateMessage({ type: "awaiting-approval", pairingCode: "1234" });
    expect(statuses.at(-1)).toEqual({ kind: "awaiting-approval", pairingCode: "1234" });

    ws.simulateMessage({ type: "pair-approve" });
    expect(ws.sent.at(-1)).toEqual({ type: "snapshot-request" });
    expect(statuses.at(-1)).toEqual({ kind: "receiving" });

    ws.simulateMessage({ type: "snapshot-manifest", snapshot: VALID_SNAPSHOT });

    const bytesA = new Uint8Array([1, 2, 3, 4]);
    ws.simulateMessage({ type: "image-chunk", id: "img-a", index: 0, total: 1, dataBase64: toBase64(bytesA) });
    const bytesB1 = new Uint8Array([9, 8]);
    const bytesB2 = new Uint8Array([7]);
    ws.simulateMessage({ type: "image-chunk", id: "img-b", index: 0, total: 2, dataBase64: toBase64(bytesB1) });
    ws.simulateMessage({ type: "image-chunk", id: "img-b", index: 1, total: 2, dataBase64: toBase64(bytesB2) });

    ws.simulateMessage({ type: "snapshot-complete" });

    const result = await loadPromise;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot).toEqual(VALID_SNAPSHOT);
    await expect(source.image("img-a")).resolves.toEqual(bytesA);
    await expect(source.image("img-b")).resolves.toEqual(new Uint8Array([9, 8, 7]));
    await expect(source.image("img-unknown")).resolves.toBeUndefined();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED); // once load() succeeds it closes the connection itself right there, and never leaves an idle connection open
  });

  it("pair-reject -> rejected", async () => {
    const source = new RelaySource();
    const loadPromise = source.load();
    const ws = await waitForSocket();
    ws.simulateOpen();
    ws.simulateMessage({ type: "awaiting-approval", pairingCode: "1234" });
    ws.simulateMessage({ type: "pair-reject" });

    const result = await loadPromise;
    expect(result).toEqual({ ok: false, error: { type: "rejected" } });
  });

  it("session-expired -> expired", async () => {
    const source = new RelaySource();
    const loadPromise = source.load();
    const ws = await waitForSocket();
    ws.simulateOpen();
    ws.simulateMessage({ type: "session-expired" });

    const result = await loadPromise;
    expect(result).toEqual({ ok: false, error: { type: "expired" } });
  });

  it("a host-offline message -> host-offline", async () => {
    const source = new RelaySource();
    const loadPromise = source.load();
    const ws = await waitForSocket();
    ws.simulateOpen();
    ws.simulateMessage({ type: "host-offline" });

    const result = await loadPromise;
    expect(result).toEqual({ ok: false, error: { type: "host-offline" } });
  });

  it("the WebSocket closes mid-transfer (manifest received, but not yet complete) -> host-offline", async () => {
    const source = new RelaySource();
    const loadPromise = source.load();
    const ws = await waitForSocket();
    ws.simulateOpen();
    ws.simulateMessage({ type: "awaiting-approval", pairingCode: "1234" });
    ws.simulateMessage({ type: "pair-approve" });
    ws.simulateMessage({ type: "snapshot-manifest", snapshot: VALID_SNAPSHOT });
    ws.simulateClose(); // no image-chunk or snapshot-complete received yet

    const result = await loadPromise;
    expect(result).toEqual({ ok: false, error: { type: "host-offline" } });
  });

  it("a chunk sequence number skips ahead (jumps straight from 0 to 2) -> fail-closed, unavailable", async () => {
    const source = new RelaySource();
    const loadPromise = source.load();
    const ws = await waitForSocket();
    ws.simulateOpen();
    ws.simulateMessage({ type: "awaiting-approval", pairingCode: "1234" });
    ws.simulateMessage({ type: "pair-approve" });
    ws.simulateMessage({ type: "snapshot-manifest", snapshot: VALID_SNAPSHOT });
    ws.simulateMessage({ type: "image-chunk", id: "img-a", index: 2, total: 3, dataBase64: toBase64(new Uint8Array([1])) });

    const result = await loadPromise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("unavailable");
  });

  it("accumulated bytes exceed the byteLength the manifest claimed -> fail-closed, unavailable", async () => {
    const source = new RelaySource();
    const loadPromise = source.load();
    const ws = await waitForSocket();
    ws.simulateOpen();
    ws.simulateMessage({ type: "awaiting-approval", pairingCode: "1234" });
    ws.simulateMessage({ type: "pair-approve" });
    ws.simulateMessage({ type: "snapshot-manifest", snapshot: VALID_SNAPSHOT }); // img-a claims 4 bytes
    ws.simulateMessage({
      type: "image-chunk",
      id: "img-a",
      index: 0,
      total: 1,
      dataBase64: toBase64(new Uint8Array([1, 2, 3, 4, 5])), // actually sends 5 bytes, over the claimed size
    });

    const result = await loadPromise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("unavailable");
  });

  it("an image-chunk carries an unknown image id (never declared in the manifest) -> fail-closed, unavailable", async () => {
    const source = new RelaySource();
    const loadPromise = source.load();
    const ws = await waitForSocket();
    ws.simulateOpen();
    ws.simulateMessage({ type: "awaiting-approval", pairingCode: "1234" });
    ws.simulateMessage({ type: "pair-approve" });
    ws.simulateMessage({ type: "snapshot-manifest", snapshot: VALID_SNAPSHOT });
    ws.simulateMessage({ type: "image-chunk", id: "img-ghost", index: 0, total: 1, dataBase64: toBase64(new Uint8Array([1])) });

    const result = await loadPromise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("unavailable");
  });

  it("at snapshot-complete, one image's accumulated bytes don't equal the claimed size (received too few) -> fail-closed, unavailable", async () => {
    const source = new RelaySource();
    const loadPromise = source.load();
    const ws = await waitForSocket();
    ws.simulateOpen();
    ws.simulateMessage({ type: "awaiting-approval", pairingCode: "1234" });
    ws.simulateMessage({ type: "pair-approve" });
    ws.simulateMessage({ type: "snapshot-manifest", snapshot: VALID_SNAPSHOT });
    // img-a claims 4 bytes, but only 1 chunk of 2 bytes is sent before going straight to complete.
    ws.simulateMessage({ type: "image-chunk", id: "img-a", index: 0, total: 1, dataBase64: toBase64(new Uint8Array([1, 2])) });
    ws.simulateMessage({ type: "image-chunk", id: "img-b", index: 0, total: 1, dataBase64: toBase64(new Uint8Array([9, 8, 7])) });
    ws.simulateMessage({ type: "snapshot-complete" });

    const result = await loadPromise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("unavailable");
  });

  it("the manifest claims an image size over the protocol cap (MAX_IMAGE_BYTES) -> the shape validation blocks it directly, unavailable", async () => {
    const oversized: PreviewSnapshot = {
      story: VALID_SNAPSHOT.story,
      images: [{ id: "img-a", mime: "image/png", byteLength: 6 * 1024 * 1024 }], // > the 5 MiB cap
      revision: 1,
    };
    const source = new RelaySource();
    const loadPromise = source.load();
    const ws = await waitForSocket();
    ws.simulateOpen();
    ws.simulateMessage({ type: "awaiting-approval", pairingCode: "1234" });
    ws.simulateMessage({ type: "pair-approve" });
    ws.simulateMessage({ type: "snapshot-manifest", snapshot: oversized });

    const result = await loadPromise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("unavailable");
  });

  it("the URL fragment is missing #t=<viewerToken> -> no-token, never attempts to connect", async () => {
    // location/history are read at call time (not a value cached at module-load time), so no
    // module re-import is needed here - only RELAY_URL (import.meta.env) needs the
    // freshRelaySourceModule() re-import ritual.
    vi.stubGlobal("location", { hash: "", pathname: "/preview.html", search: "", origin: "https://example.test" });
    const source = new RelaySource();

    const result = await source.load();
    expect(result).toEqual({ ok: false, error: { type: "no-token" } });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("the token in the URL fragment doesn't match VIEWER_TOKEN_PATTERN -> no-token", async () => {
    vi.stubGlobal("location", { hash: "#t=not-a-valid-token", pathname: "/preview.html", search: "", origin: "https://example.test" });
    const source = new RelaySource();

    const result = await source.load();
    expect(result).toEqual({ ok: false, error: { type: "no-token" } });
  });

  it("clears the URL right after reading the fragment (never left in history/screenshots)", async () => {
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
    const source = new RelaySource();
    const loadPromise = source.load();

    // `consumeViewerTokenFromLocation()` is the first line of `#connect()`, before its first
    // `await` - calling an async function already synchronously runs up to its first await, so
    // there's no need to await `loadPromise` first to observe this side effect.
    expect(replaceState).toHaveBeenCalledWith(null, "", "/preview.html");

    // Cleanup: run this load() to completion (open a socket, then actively close it), so no
    // promise is left dangling mid-flight - an unconsumed `new WebSocket(...)` call only
    // actually fires a few microtasks later, and if it's allowed to drift past this test's
    // boundary, it will silently add an extra entry to the next test's `FakeWebSocket.instances`
    // count, contaminating that test.
    const ws = await waitForSocket();
    ws.simulateClose();
    await loadPromise;
  });

  it("VITE_PREVIEW_RELAY_URL is not set -> unavailable, never attempts to connect", async () => {
    await freshRelaySourceModule(undefined);
    const source = new RelaySource();

    const result = await source.load();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("unavailable");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("load() only ever really connects once - a second call returns the same Promise", async () => {
    const source = new RelaySource();
    const first = source.load();
    await waitForSocket();
    const second = source.load();
    expect(second).toBe(first);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("dispose() closes the underlying connection", async () => {
    const source = new RelaySource();
    void source.load();
    const ws = await waitForSocket();
    ws.simulateOpen();

    source.dispose();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
