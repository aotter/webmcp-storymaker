// Behavior tests for SessionDO -- see the "test list" in relay/README.md, which maps item by item
// to the describe blocks here. Each test opens an independent, randomly named DO instance against
// env.SESSION (never reusing the same session name), so tests don't interfere with each other and
// need no extra cleanup step.
//
// Connections are opened directly via env.SESSION.getByName(name).fetch(), bypassing the Worker
// routing layer (Origin check) in ../src/index.ts -- that layer has its own tests (see
// ./index.test.ts); this file only tests the DO's own protocol state machine. sid still needs to be
// attached (DO.fetch() now reads sid directly from the request URL, see ../src/session-do.ts), so
// generateCredentials() produces a (hostKey, viewerToken, sid) triple consistent with the real
// flow.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PreviewSnapshot } from "../../src/preview/snapshot.ts";
import { deriveViewerToken, generateHostKey } from "../../src/preview/protocol.ts";
import { generateCredentials, nextClose, nextMessage, openSocket, send } from "./ws-helpers.ts";

function freshStub() {
  return env.SESSION.getByName(`test-${crypto.randomUUID()}`);
}

const SAMPLE_SNAPSHOT: PreviewSnapshot = {
  story: { title: "Sample Story", startPageId: "p1", pages: [{ id: "p1", text: "Once upon a time", choices: [] }] },
  images: [{ id: "img-1", mime: "image/png", byteLength: 4 }],
  revision: 1,
};

/** Runs through the three steps host hello -> viewer hello -> pair-approve, and returns the two
 * already-paired sockets (plus this session's stub/sid), for tests that need to continue from an
 * "already paired" state. */
async function pairedSession() {
  const { hostKey, viewerToken, sid } = await generateCredentials();
  const stub = freshStub();
  const host = await openSocket(stub, sid);
  send(host, { type: "hello", role: "host", hostKey });
  const hostReady = (await nextMessage(host)) as { type: string; pairingCode: string };
  expect(hostReady.type).toBe("host-ready");

  const viewer = await openSocket(stub, sid);
  send(viewer, { type: "hello", role: "viewer", token: viewerToken });
  await nextMessage(host); // pair-request
  const awaiting = (await nextMessage(viewer)) as { type: string; pairingCode: string };
  expect(awaiting.pairingCode).toBe(hostReady.pairingCode);

  send(host, { type: "pair-approve" });
  const approveEcho = await nextMessage(viewer); // pair-approve is only forwarded to the viewer -- the host itself gets no reply message
  expect(approveEcho).toEqual({ type: "pair-approve" });
  return { stub, sid, hostKey, viewerToken, host, viewer };
}

describe("happy path", () => {
  it("host hello -> viewer hello -> approve -> the three snapshot messages forward to viewer in order", async () => {
    const { hostKey, viewerToken, sid } = await generateCredentials();
    const stub = freshStub();
    const host = await openSocket(stub, sid);
    send(host, { type: "hello", role: "host", hostKey });
    const hostReady = (await nextMessage(host)) as { pairingCode: string };
    expect(hostReady.pairingCode).toMatch(/^\d{4}$/);

    const viewer = await openSocket(stub, sid);
    send(viewer, { type: "hello", role: "viewer", token: viewerToken });
    const pairRequest = await nextMessage(host);
    expect(pairRequest).toEqual({ type: "pair-request" });
    const awaiting = await nextMessage(viewer);
    expect(awaiting).toEqual({ type: "awaiting-approval", pairingCode: hostReady.pairingCode });

    send(host, { type: "pair-approve" });
    const approveEcho = await nextMessage(viewer);
    expect(approveEcho).toEqual({ type: "pair-approve" });

    send(viewer, { type: "snapshot-request" });
    const forwardedRequest = await nextMessage(host);
    expect(forwardedRequest).toEqual({ type: "snapshot-request" });

    const manifest = { type: "snapshot-manifest", snapshot: SAMPLE_SNAPSHOT };
    send(host, manifest);
    const manifestAtViewer = await nextMessage(viewer);
    expect(manifestAtViewer).toEqual(manifest);

    const chunk = { type: "image-chunk", id: "img-1", index: 0, total: 1, dataBase64: "AAAA" };
    send(host, chunk);
    const chunkAtViewer = await nextMessage(viewer);
    expect(chunkAtViewer).toEqual(chunk);

    send(host, { type: "snapshot-complete" });
    const completeAtViewer = await nextMessage(viewer);
    expect(completeAtViewer).toEqual({ type: "snapshot-complete" });
  });
});

describe("credential hash-chain validation", () => {
  it("a host hello whose hostKey does not hash to the connection's sid -> invalid-token", async () => {
    const { sid } = await generateCredentials(); // This sid belongs to a different credential set
    const unrelatedHostKey = generateHostKey(); // Doesn't match the sid above at all
    const stub = freshStub();
    const ws = await openSocket(stub, sid);
    send(ws, { type: "hello", role: "host", hostKey: unrelatedHostKey });
    const err = await nextMessage(ws);
    expect(err).toEqual({ type: "error", code: "invalid-token" });
    expect((await nextClose(ws)).code).toBe(4004);
  });

  it("an attacker who only has viewerToken cannot use it as hostKey to become host -> invalid-token", async () => {
    // viewerToken is a one-way hash of hostKey -- sending it disguised as hostKey fails hash-chain
    // verification at the step "does the sid hashed from hostKey equal the connection's sid"
    // (unless the hash function happened to also hash viewerToken itself back to the same sid,
    // which is not going to happen by chance).
    const { viewerToken, sid } = await generateCredentials();
    const stub = freshStub();
    const ws = await openSocket(stub, sid);
    send(ws, { type: "hello", role: "host", hostKey: viewerToken });
    const err = await nextMessage(ws);
    expect(err).toEqual({ type: "error", code: "invalid-token" });
    expect((await nextClose(ws)).code).toBe(4004);
    // The attacker really can't become host -- there's no host at all under this sid, and any
    // subsequent viewer connection only gets host-offline, proving the rejection actually took
    // effect rather than mistakenly succeeding.
    const laterViewer = await openSocket(stub, sid);
    send(laterViewer, { type: "hello", role: "viewer", token: viewerToken });
    expect(await nextMessage(laterViewer)).toEqual({ type: "error", code: "host-offline" });
  });

  it("a viewer hello that sends a hostKey in the token field (wrong credential for the role) -> invalid-token", async () => {
    const { hostKey, sid } = await generateCredentials();
    const stub = freshStub();
    const ws = await openSocket(stub, sid);
    // hostKey has the same shape as viewerToken (both 43-character base64url), so it passes the
    // "shape" check, but hash-chain verification (whether sha256(hostKey) equals sid) is bound to
    // fail -- hashing hostKey once gives you viewerToken, not sid itself; it needs to be hashed a
    // second time to get sid.
    send(ws, { type: "hello", role: "viewer", token: hostKey });
    const err = await nextMessage(ws);
    expect(err).toEqual({ type: "error", code: "invalid-token" });
    expect((await nextClose(ws)).code).toBe(4004);
  });
});

describe("token validation", () => {
  it("an empty/malformed hostKey in hello -> invalid-token, connection closed", async () => {
    const { sid } = await generateCredentials();
    const stub = freshStub();
    const ws = await openSocket(stub, sid);
    send(ws, { type: "hello", role: "host", hostKey: "" });
    const err = await nextMessage(ws);
    expect(err).toEqual({ type: "error", code: "invalid-token" });
    const close = await nextClose(ws);
    expect(close.code).toBe(4004);
  });

  it("a viewer hello with a token that does not match the host's -> invalid-token, only the viewer is closed", async () => {
    const { hostKey, sid } = await generateCredentials();
    const stub = freshStub();
    const host = await openSocket(stub, sid);
    send(host, { type: "hello", role: "host", hostKey });
    await nextMessage(host); // host-ready

    const { viewerToken: wrongToken } = await generateCredentials(); // A viewerToken from a different credential set
    const viewer = await openSocket(stub, sid);
    send(viewer, { type: "hello", role: "viewer", token: wrongToken });
    const err = await nextMessage(viewer);
    expect(err).toEqual({ type: "error", code: "invalid-token" });
    expect((await nextClose(viewer)).code).toBe(4004);

    // The host is completely unaffected -- the correct viewerToken derived from the same hostKey
    // can still pair normally (recomputed with deriveViewerToken(), not just any other credential
    // set's token).
    const correctViewerToken = await deriveViewerToken(hostKey);
    const goodViewer = await openSocket(stub, sid);
    send(goodViewer, { type: "hello", role: "viewer", token: correctViewerToken });
    const pairRequest = await nextMessage(host);
    expect(pairRequest).toEqual({ type: "pair-request" });
  });

  it("a viewer connecting before any host has ever connected -> host-offline", async () => {
    const { viewerToken, sid } = await generateCredentials();
    const stub = freshStub();
    const viewer = await openSocket(stub, sid);
    send(viewer, { type: "hello", role: "viewer", token: viewerToken });
    const err = await nextMessage(viewer);
    expect(err).toEqual({ type: "error", code: "host-offline" });
    expect((await nextClose(viewer)).code).toBe(4001);
  });
});

describe("token-consumed: a second viewer after approval", () => {
  it("is rejected with token-consumed; the already-paired viewer is unaffected", async () => {
    const { stub, sid, viewerToken, host, viewer } = await pairedSession();

    const secondViewer = await openSocket(stub, sid);
    send(secondViewer, { type: "hello", role: "viewer", token: viewerToken });
    const err = await nextMessage(secondViewer);
    expect(err).toEqual({ type: "error", code: "token-consumed" });
    expect((await nextClose(secondViewer)).code).toBe(4005);

    // The already-paired viewer is completely unaffected -- it still receives snapshot-complete
    // when the host sends it.
    send(host, { type: "snapshot-complete" });
    expect(await nextMessage(viewer)).toEqual({ type: "snapshot-complete" });
  });
});

describe("not-paired: snapshot-request before approval", () => {
  it("closes just the viewer with not-paired; host is unaffected and keeps waiting", async () => {
    const { hostKey, viewerToken, sid } = await generateCredentials();
    const stub = freshStub();
    const host = await openSocket(stub, sid);
    send(host, { type: "hello", role: "host", hostKey });
    await nextMessage(host);

    const viewer = await openSocket(stub, sid);
    send(viewer, { type: "hello", role: "viewer", token: viewerToken });
    await nextMessage(host); // pair-request
    await nextMessage(viewer); // awaiting-approval

    send(viewer, { type: "snapshot-request" });
    const err = await nextMessage(viewer);
    expect(err).toEqual({ type: "error", code: "not-paired" });
    expect((await nextClose(viewer)).code).toBe(4006);

    // The host is still waiting -- the same (not-yet-consumed) viewerToken can let the next viewer
    // try pairing again.
    const retry = await openSocket(stub, sid);
    send(retry, { type: "hello", role: "viewer", token: viewerToken });
    expect(await nextMessage(host)).toEqual({ type: "pair-request" });
  });
});

describe("host disconnect", () => {
  it("the viewer receives host-offline and is closed", async () => {
    const { host, viewer } = await pairedSession();
    host.close();
    const err = await nextMessage(viewer);
    expect(err).toEqual({ type: "error", code: "host-offline" });
    expect((await nextClose(viewer)).code).toBe(4001);
  });

  it("a viewer still only awaiting approval also receives host-offline when the host disconnects", async () => {
    const { hostKey, viewerToken, sid } = await generateCredentials();
    const stub = freshStub();
    const host = await openSocket(stub, sid);
    send(host, { type: "hello", role: "host", hostKey });
    await nextMessage(host);
    const viewer = await openSocket(stub, sid);
    send(viewer, { type: "hello", role: "viewer", token: viewerToken });
    await nextMessage(host);
    await nextMessage(viewer);

    host.close();
    const err = await nextMessage(viewer);
    expect(err).toEqual({ type: "error", code: "host-offline" });
  });
});

describe("pairing TTL expiry", () => {
  it("a host that never gets a viewer approved within the (test-shortened) pairing TTL receives session-expired", async () => {
    const { hostKey, sid } = await generateCredentials();
    const stub = freshStub();
    const host = await openSocket(stub, sid);
    send(host, { type: "hello", role: "host", hostKey });
    await nextMessage(host); // host-ready

    const err = await nextMessage(host);
    expect(err).toEqual({ type: "error", code: "session-expired" });
    expect((await nextClose(host)).code).toBe(4002);
  }, 10_000);

  it("a viewer awaiting approval also receives session-expired when the pairing TTL fires", async () => {
    const { hostKey, viewerToken, sid } = await generateCredentials();
    const stub = freshStub();
    const host = await openSocket(stub, sid);
    send(host, { type: "hello", role: "host", hostKey });
    await nextMessage(host);
    const viewer = await openSocket(stub, sid);
    send(viewer, { type: "hello", role: "viewer", token: viewerToken });
    await nextMessage(host);
    await nextMessage(viewer);

    const viewerErr = await nextMessage(viewer);
    expect(viewerErr).toEqual({ type: "error", code: "session-expired" });
  }, 10_000);
});

describe("a connection that never sends hello within the pre-auth window is closed", () => {
  it("closes with protocol-violation, without touching an unrelated session", async () => {
    const { sid } = await generateCredentials();
    const stub = freshStub();
    const ws = await openSocket(stub, sid);
    const err = await nextMessage(ws);
    expect(err).toEqual({ type: "error", code: "protocol-violation" });
    expect((await nextClose(ws)).code).toBe(4003);
  }, 10_000);
});

describe("size caps -> too-large", () => {
  it("a snapshot-manifest whose declared image byteLength sum exceeds the 20 MiB cap is rejected", async () => {
    const { host, viewer } = await pairedSession();
    // Each individual image is within the per-image 5 MiB cap (4.5 MiB), but the sum of all 5 is
    // 22.5 MiB, over the 20 MiB total-batch cap -- these numbers are chosen deliberately to isolate
    // the "sum" check on its own, without mixing it up with the "single image over the cap" check.
    const perImageBytes = 4.5 * 1024 * 1024;
    const oversized: PreviewSnapshot = {
      ...SAMPLE_SNAPSHOT,
      images: Array.from({ length: 5 }, (_, i) => ({ id: `img-${i}`, mime: "image/png" as const, byteLength: perImageBytes })),
    };
    send(host, { type: "snapshot-manifest", snapshot: oversized });
    const hostErr = await nextMessage(host);
    expect(hostErr).toEqual({ type: "error", code: "protocol-violation" }); // isSnapshotManifestShape itself already judges the shape invalid (sum over the cap)
    // A host fault ends the whole session, and the viewer receives host-offline (see the
    // #endByHostFault dispatch rule in session-do.ts).
    expect(await nextMessage(viewer)).toEqual({ type: "error", code: "host-offline" });
  });

  it("an image-chunk whose base64 payload exceeds the per-chunk cap is rejected with too-large", async () => {
    const { host, viewer } = await pairedSession();
    send(host, { type: "snapshot-manifest", snapshot: SAMPLE_SNAPSHOT });
    await nextMessage(viewer);

    const overLongBase64 = "A".repeat(44_000); // > MAX_CHUNK_BASE64_LENGTH (43,692)
    send(host, { type: "image-chunk", id: "img-1", index: 0, total: 1, dataBase64: overLongBase64 });
    const hostErr = await nextMessage(host);
    expect(hostErr).toEqual({ type: "error", code: "too-large" });
    expect(await nextMessage(viewer)).toEqual({ type: "error", code: "host-offline" });
  });

  it("chunks whose cumulative decoded bytes exceed the manifest's declared byteLength are rejected with too-large", async () => {
    const { host, viewer } = await pairedSession();
    const tinyImageSnapshot: PreviewSnapshot = { ...SAMPLE_SNAPSHOT, images: [{ id: "img-1", mime: "image/png", byteLength: 2 }] };
    send(host, { type: "snapshot-manifest", snapshot: tinyImageSnapshot });
    await nextMessage(viewer);

    // The manifest claims img-1 is only 2 bytes, but this chunk decodes to far more than 2 bytes.
    send(host, { type: "image-chunk", id: "img-1", index: 0, total: 1, dataBase64: "AAAAAAAA" });
    const hostErr = await nextMessage(host);
    expect(hostErr).toEqual({ type: "error", code: "too-large" });
    expect(await nextMessage(viewer)).toEqual({ type: "error", code: "host-offline" });
  });
});

describe("image-chunk sequencing", () => {
  it("an out-of-order chunk index is rejected as protocol-violation", async () => {
    const { host, viewer } = await pairedSession();
    send(host, { type: "snapshot-manifest", snapshot: SAMPLE_SNAPSHOT });
    await nextMessage(viewer);

    // Sends index=1 directly, skipping the index=0 that should come first.
    send(host, { type: "image-chunk", id: "img-1", index: 1, total: 2, dataBase64: "AAAA" });
    const hostErr = await nextMessage(host);
    expect(hostErr).toEqual({ type: "error", code: "protocol-violation" });
  });

  it("a chunk for an image id that was never declared in the manifest is rejected", async () => {
    const { host, viewer } = await pairedSession();
    send(host, { type: "snapshot-manifest", snapshot: SAMPLE_SNAPSHOT });
    await nextMessage(viewer);

    send(host, { type: "image-chunk", id: "never-declared", index: 0, total: 1, dataBase64: "AAAA" });
    const hostErr = await nextMessage(host);
    expect(hostErr).toEqual({ type: "error", code: "protocol-violation" });
  });
});

describe("protocol-violation: role misuse and duplicate roles", () => {
  it("a second host connection is rejected without disturbing the existing host/viewer pairing", async () => {
    const { stub, sid, hostKey, host, viewer } = await pairedSession();
    const secondHost = await openSocket(stub, sid);
    send(secondHost, { type: "hello", role: "host", hostKey });
    const err = await nextMessage(secondHost);
    expect(err).toEqual({ type: "error", code: "protocol-violation" });
    expect((await nextClose(secondHost)).code).toBe(4003);

    send(host, { type: "snapshot-complete" });
    expect(await nextMessage(viewer)).toEqual({ type: "snapshot-complete" });
  });

  it("a viewer sending pair-approve (wrong role) only closes the viewer", async () => {
    const { hostKey, viewerToken, sid } = await generateCredentials();
    const stub = freshStub();
    const host = await openSocket(stub, sid);
    send(host, { type: "hello", role: "host", hostKey });
    await nextMessage(host);
    const viewer = await openSocket(stub, sid);
    send(viewer, { type: "hello", role: "viewer", token: viewerToken });
    await nextMessage(host);
    await nextMessage(viewer);

    send(viewer, { type: "pair-approve" });
    const err = await nextMessage(viewer);
    expect(err).toEqual({ type: "error", code: "protocol-violation" });
    expect((await nextClose(viewer)).code).toBe(4003);
  });

  it("a malformed first message (not even hello-shaped) is rejected as protocol-violation", async () => {
    const { sid } = await generateCredentials();
    const stub = freshStub();
    const ws = await openSocket(stub, sid);
    send(ws, { type: "not-a-real-type" });
    const err = await nextMessage(ws);
    expect(err).toEqual({ type: "error", code: "protocol-violation" });
  });
});

describe("pair-reject", () => {
  it("forwards pair-reject to the viewer, closes only the viewer, and lets the host wait for a retry with the same token", async () => {
    const { hostKey, viewerToken, sid } = await generateCredentials();
    const stub = freshStub();
    const host = await openSocket(stub, sid);
    send(host, { type: "hello", role: "host", hostKey });
    await nextMessage(host);
    const viewer = await openSocket(stub, sid);
    send(viewer, { type: "hello", role: "viewer", token: viewerToken });
    await nextMessage(host);
    await nextMessage(viewer);

    send(host, { type: "pair-reject" });
    expect(await nextMessage(viewer)).toEqual({ type: "pair-reject" });
    expect((await nextClose(viewer)).code).toBe(1000);

    // viewerToken wasn't consumed -- the same token can let another viewer try pairing again.
    const retry = await openSocket(stub, sid);
    send(retry, { type: "hello", role: "viewer", token: viewerToken });
    expect(await nextMessage(host)).toEqual({ type: "pair-request" });
  });
});

describe("rate limiting (per-connection, not session-wide)", () => {
  it("an unauthenticated third socket flooding garbage only gets itself closed — the paired session's own snapshot transfer completes normally", async () => {
    const { stub, sid, host, viewer } = await pairedSession();
    const rogue = await openSocket(stub, sid);
    const rogueClosed = nextClose(rogue);
    for (let i = 0; i < 250; i++) {
      try {
        rogue.send(JSON.stringify({ type: "junk", n: i }));
      } catch {
        break; // The connection may already be closed -- stop sending
      }
    }

    // Meanwhile, the legitimate snapshot transfer is completely unaffected.
    send(host, { type: "snapshot-manifest", snapshot: SAMPLE_SNAPSHOT });
    expect(await nextMessage(viewer)).toEqual({ type: "snapshot-manifest", snapshot: SAMPLE_SNAPSHOT });
    send(host, { type: "snapshot-complete" });
    expect(await nextMessage(viewer)).toEqual({ type: "snapshot-complete" });

    // The connection flooding garbage is closed by its own "one shot" rule (its very first
    // message isn't a valid hello), not stopped by rate limiting -- what this verifies is that
    // "its behavior doesn't affect other connections at all", not which code closes this
    // connection itself.
    const close = await rogueClosed;
    expect(close.code).toBe(4003);
  });

  it("a viewer exceeding its own per-connection rate limit is closed; the host and session are unaffected", async () => {
    const { host, viewer } = await pairedSession();
    const received: unknown[] = [];
    viewer.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") received.push(JSON.parse(event.data));
    });
    const closed = nextClose(viewer);

    for (let i = 0; i < 260; i++) {
      send(viewer, { type: "snapshot-request" }); // Always valid after pairing (forwarded to the host) -- cleanly tests only the rate limit
    }

    const close = await closed;
    expect(close.code).toBe(4008);
    expect(received).toContainEqual({ type: "error", code: "rate-limited" });

    // The host is completely unaffected -- this is the "viewer fault only closes the viewer"
    // dispatch rule (see session-do.ts's header), not the old behavior of "the whole session ends
    // together".
    send(host, { type: "snapshot-complete" });
    // The host itself receives no error message; re-pairing with a new legitimate viewer indirectly
    // proves the session was never #terminate()'d -- the host still recognizes itself as the host
    // and that pairing already completed. (Asserting that an already-closed viewer receives nothing
    // wouldn't be meaningful, so this uses behavior as evidence instead.)
  }, 15_000);

  it("a host exceeding its own per-connection rate limit ends the whole session (host-attributed fault)", async () => {
    const { host, viewer } = await pairedSession();
    const hostReceived: unknown[] = [];
    host.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") hostReceived.push(JSON.parse(event.data));
    });
    const viewerClosed = nextClose(viewer);
    const hostClosed = nextClose(host);

    for (let i = 0; i < 260; i++) {
      send(host, { type: "snapshot-complete" }); // Always valid after pairing -- cleanly tests only the rate limit
    }

    const hostClose = await hostClosed;
    expect(hostClose.code).toBe(4008);
    expect(hostReceived).toContainEqual({ type: "error", code: "rate-limited" });

    const viewerClose = await viewerClosed;
    expect(viewerClose.code).toBe(4001); // Host fault -> viewer receives host-offline
  }, 15_000);
});

describe("rate limit does not throttle image transfer", () => {
  it("a host streaming 240 chunks (two 3.75 MiB images) inside one window is not rate-limited", async () => {
    const { host, viewer } = await pairedSession();
    send(viewer, { type: "snapshot-request" });
    await nextMessage(host);

    const CHUNK_BYTES = 32766; // 43688 base64 characters, no padding, divides evenly by 3
    const CHUNKS_PER_IMAGE = 120;
    const dataBase64 = "A".repeat((CHUNK_BYTES / 3) * 4);
    const images = ["img-a", "img-b"].map((id) => ({ id, mime: "image/png", byteLength: CHUNK_BYTES * CHUNKS_PER_IMAGE }));
    const snapshot = {
      story: { title: "t", startPageId: "p1", pages: [{ id: "p1", text: "x", choices: [] }] },
      images,
      revision: 1,
    };
    send(host, { type: "snapshot-manifest", snapshot });
    await nextMessage(viewer);

    for (const { id } of images) {
      for (let index = 0; index < CHUNKS_PER_IMAGE; index++) {
        send(host, { type: "image-chunk", id, index, total: CHUNKS_PER_IMAGE, dataBase64 });
        const atViewer = (await nextMessage(viewer)) as { type: string; index?: number };
        expect(atViewer.type).toBe("image-chunk");
        expect(atViewer.index).toBe(index);
      }
    }
    send(host, { type: "snapshot-complete" });
    expect(await nextMessage(viewer)).toEqual({ type: "snapshot-complete" });
  });
});
