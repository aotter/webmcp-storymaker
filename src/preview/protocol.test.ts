// Covers relay/README.md's "Test checklist" item: the protocol type's runtime validation
// functions -- every bad shape (null, an array, a missing field, an over-length string, an
// illegal code) must fail-closed.
// This test only exercises ./protocol.ts's pure functions, and touches no workspace/webmcp
// fixtures at all, so it carries no `.workspace`/`.webmcp` suffix - the usual convention that
// a zero-I/O pure-type file like ../story/types.ts has no dedicated test file doesn't hold
// here, because there's an explicit requirement to cover.
import { describe, expect, it } from "vitest";
import {
  HOST_KEY_PATTERN,
  MAX_CHUNK_BASE64_LENGTH,
  PREVIEW_ERROR_CODES,
  SID_PATTERN,
  VIEWER_TOKEN_PATTERN,
  deriveSid,
  deriveViewerToken,
  generateHostKey,
  isClientToRelayMessage,
  isHelloMessage,
  isHostHelloMessage,
  isImageChunkMessage,
  isPairingCode,
  isPreviewErrorCode,
  isPreviewRole,
  isPreviewSnapshot,
  isRelayToClientMessage,
  isSid,
  isSnapshotManifestMessage,
  isViewerHelloMessage,
  tryParseJson,
} from "./protocol.ts";
import type { PreviewSnapshot } from "./snapshot.ts";

const validSnapshot: PreviewSnapshot = {
  story: {
    title: "Sample Story",
    startPageId: "p1",
    pages: [{ id: "p1", text: "Once upon a time", choices: [] }],
  },
  images: [],
  revision: 1,
};

describe("protocol.ts — fail-closed runtime validators", () => {
  describe("isHostHelloMessage / isViewerHelloMessage / isHelloMessage (hash-chain credentials)", () => {
    it("accepts a well-formed host hello and a well-formed viewer hello", async () => {
      const hostKey = generateHostKey();
      const viewerToken = await deriveViewerToken(hostKey);
      expect(isHostHelloMessage({ type: "hello", role: "host", hostKey })).toBe(true);
      expect(isHelloMessage({ type: "hello", role: "host", hostKey })).toBe(true);
      expect(isViewerHelloMessage({ type: "hello", role: "viewer", token: viewerToken })).toBe(true);
      expect(isHelloMessage({ type: "hello", role: "viewer", token: viewerToken })).toBe(true);
    });

    it("rejects null/undefined/arrays/primitives — not a plain object", () => {
      expect(isHelloMessage(null)).toBe(false);
      expect(isHelloMessage(undefined)).toBe(false);
      expect(isHelloMessage([{ type: "hello", role: "host", hostKey: generateHostKey() }])).toBe(false);
      expect(isHelloMessage("hello")).toBe(false);
      expect(isHelloMessage(42)).toBe(false);
    });

    it("rejects a missing field", () => {
      expect(isHelloMessage({ type: "hello", role: "host" })).toBe(false);
      expect(isHelloMessage({ type: "hello", hostKey: generateHostKey() })).toBe(false);
    });

    it("rejects an invalid role (not in the closed set)", () => {
      expect(isHelloMessage({ type: "hello", role: "admin", hostKey: generateHostKey() })).toBe(false);
    });

    it("rejects a hostKey/token that doesn't match the exact 43-char base64url shape (empty, too short, too long, wrong charset)", () => {
      const validHostKey = generateHostKey();
      expect(isHostHelloMessage({ type: "hello", role: "host", hostKey: "" })).toBe(false);
      expect(isHostHelloMessage({ type: "hello", role: "host", hostKey: "short" })).toBe(false);
      expect(isHostHelloMessage({ type: "hello", role: "host", hostKey: validHostKey + "x" })).toBe(false);
      expect(isHostHelloMessage({ type: "hello", role: "host", hostKey: "!".repeat(43) })).toBe(false);
      expect(isViewerHelloMessage({ type: "hello", role: "viewer", token: "" })).toBe(false);
      expect(isViewerHelloMessage({ type: "hello", role: "viewer", token: "short" })).toBe(false);
    });

    it("rejects a non-string hostKey/token", () => {
      expect(isHostHelloMessage({ type: "hello", role: "host", hostKey: 12345 })).toBe(false);
      expect(isViewerHelloMessage({ type: "hello", role: "viewer", token: 12345 })).toBe(false);
    });

    it("a host hello does not satisfy isViewerHelloMessage, and vice versa — the two shapes are mutually exclusive by role", async () => {
      const hostKey = generateHostKey();
      const viewerToken = await deriveViewerToken(hostKey);
      expect(isViewerHelloMessage({ type: "hello", role: "host", hostKey })).toBe(false);
      expect(isHostHelloMessage({ type: "hello", role: "viewer", token: viewerToken })).toBe(false);
    });
  });

  describe("credential derivation: generateHostKey / deriveViewerToken / deriveSid", () => {
    it("generateHostKey() produces values matching HOST_KEY_PATTERN, different on every call", () => {
      const a = generateHostKey();
      const b = generateHostKey();
      expect(a).toMatch(HOST_KEY_PATTERN);
      expect(b).toMatch(HOST_KEY_PATTERN);
      expect(a).not.toBe(b);
    });

    it("deriveViewerToken/deriveSid are deterministic and match their patterns", async () => {
      const hostKey = generateHostKey();
      const viewerToken1 = await deriveViewerToken(hostKey);
      const viewerToken2 = await deriveViewerToken(hostKey);
      expect(viewerToken1).toBe(viewerToken2);
      expect(viewerToken1).toMatch(VIEWER_TOKEN_PATTERN);

      const sid1 = await deriveSid(viewerToken1);
      const sid2 = await deriveSid(viewerToken1);
      expect(sid1).toBe(sid2);
      expect(sid1).toMatch(SID_PATTERN);
      expect(isSid(sid1)).toBe(true);
    });

    it("different hostKeys derive different sids", async () => {
      const sidA = await deriveSid(await deriveViewerToken(generateHostKey()));
      const sidB = await deriveSid(await deriveViewerToken(generateHostKey()));
      expect(sidA).not.toBe(sidB);
    });
  });

  describe("isPreviewRole / isPreviewErrorCode / isPairingCode", () => {
    it("isPreviewRole only accepts the closed set", () => {
      expect(isPreviewRole("host")).toBe(true);
      expect(isPreviewRole("viewer")).toBe(true);
      expect(isPreviewRole("host ")).toBe(false);
      expect(isPreviewRole(null)).toBe(false);
    });

    it("isPreviewErrorCode rejects any code outside the closed enum", () => {
      for (const code of PREVIEW_ERROR_CODES) expect(isPreviewErrorCode(code)).toBe(true);
      expect(isPreviewErrorCode("not-a-real-code")).toBe(false);
      expect(isPreviewErrorCode(null)).toBe(false);
      expect(isPreviewErrorCode(404)).toBe(false);
    });

    it("isPairingCode only accepts exactly 4 digits", () => {
      expect(isPairingCode("0000")).toBe(true);
      expect(isPairingCode("9999")).toBe(true);
      expect(isPairingCode("123")).toBe(false);
      expect(isPairingCode("12345")).toBe(false);
      expect(isPairingCode("12a4")).toBe(false);
      expect(isPairingCode(1234)).toBe(false);
    });
  });

  describe("isImageChunkMessage", () => {
    const base = { type: "image-chunk", id: "img-1", index: 0, total: 2, dataBase64: "AAAA" };

    it("accepts a well-formed chunk", () => {
      expect(isImageChunkMessage(base)).toBe(true);
    });

    it("rejects index >= total (out-of-range sequence number)", () => {
      expect(isImageChunkMessage({ ...base, index: 2, total: 2 })).toBe(false);
      expect(isImageChunkMessage({ ...base, index: 5, total: 2 })).toBe(false);
    });

    it("rejects a negative or non-integer index", () => {
      expect(isImageChunkMessage({ ...base, index: -1 })).toBe(false);
      expect(isImageChunkMessage({ ...base, index: 1.5 })).toBe(false);
    });

    it("rejects malformed base64 (bad charset, bad padding length)", () => {
      expect(isImageChunkMessage({ ...base, dataBase64: "not base64!!" })).toBe(false);
      expect(isImageChunkMessage({ ...base, dataBase64: "A" })).toBe(false); // length is not a multiple of 4
    });

    it("rejects an over-long base64 payload (chunk-size cap)", () => {
      expect(isImageChunkMessage({ ...base, dataBase64: "A".repeat(MAX_CHUNK_BASE64_LENGTH + 4) })).toBe(false);
    });
  });

  describe("isPreviewSnapshot / isSnapshotManifestMessage", () => {
    it("accepts a well-formed snapshot", () => {
      expect(isPreviewSnapshot(validSnapshot)).toBe(true);
      expect(isSnapshotManifestMessage({ type: "snapshot-manifest", snapshot: validSnapshot })).toBe(true);
    });

    it("rejects a snapshot with zero pages", () => {
      expect(isPreviewSnapshot({ ...validSnapshot, story: { ...validSnapshot.story, pages: [] } })).toBe(false);
    });

    it("rejects a page missing required fields", () => {
      const bad = { ...validSnapshot, story: { ...validSnapshot.story, pages: [{ id: "p1" }] } };
      expect(isPreviewSnapshot(bad)).toBe(false);
    });

    it("rejects an image whose mime is outside the closed set", () => {
      const bad = { ...validSnapshot, images: [{ id: "i1", mime: "application/octet-stream", byteLength: 10 }] };
      expect(isPreviewSnapshot(bad)).toBe(false);
    });

    it("rejects when the sum of image byteLengths exceeds the snapshot total cap", () => {
      const bad = {
        ...validSnapshot,
        images: [
          { id: "i1", mime: "image/png", byteLength: 15 * 1024 * 1024 },
          { id: "i2", mime: "image/png", byteLength: 10 * 1024 * 1024 },
        ],
      };
      expect(isPreviewSnapshot(bad)).toBe(false);
    });

    it("rejects a non-integer revision", () => {
      expect(isPreviewSnapshot({ ...validSnapshot, revision: 1.2 })).toBe(false);
    });

    it("rejects manifest messages carrying an array or null instead of a snapshot object", () => {
      expect(isSnapshotManifestMessage({ type: "snapshot-manifest", snapshot: [] })).toBe(false);
      expect(isSnapshotManifestMessage({ type: "snapshot-manifest", snapshot: null })).toBe(false);
      expect(isSnapshotManifestMessage(null)).toBe(false);
      expect(isSnapshotManifestMessage([])).toBe(false);
    });
  });

  describe("isClientToRelayMessage / isRelayToClientMessage — the combined discriminators", () => {
    it("rejects an unknown message type", () => {
      expect(isClientToRelayMessage({ type: "not-a-real-type" })).toBe(false);
      expect(isRelayToClientMessage({ type: "not-a-real-type" })).toBe(false);
    });

    it("rejects a bare array or non-object even though arrays have a .length, not a .type", () => {
      expect(isClientToRelayMessage([1, 2, 3])).toBe(false);
      expect(isRelayToClientMessage([1, 2, 3])).toBe(false);
    });

    it("rejects a message whose type is not a string", () => {
      expect(isClientToRelayMessage({ type: 1 })).toBe(false);
    });

    it("routes each known type to its own guard (accepts good, rejects malformed)", async () => {
      const viewerToken = await deriveViewerToken(generateHostKey());
      expect(isClientToRelayMessage({ type: "hello", role: "viewer", token: viewerToken })).toBe(true);
      expect(isClientToRelayMessage({ type: "hello", role: "viewer" })).toBe(false);
      expect(isRelayToClientMessage({ type: "host-ready", pairingCode: "1234" })).toBe(true);
      expect(isRelayToClientMessage({ type: "host-ready", pairingCode: "12345" })).toBe(false);
      expect(isRelayToClientMessage({ type: "error", code: "invalid-token" })).toBe(true);
      expect(isRelayToClientMessage({ type: "error", code: "not-a-code" })).toBe(false);
      expect(isRelayToClientMessage({ type: "pair-approve" })).toBe(true);
      expect(isRelayToClientMessage({ type: "pair-reject" })).toBe(true);
    });
  });

  describe("tryParseJson", () => {
    it("returns ok:true with the parsed value for valid JSON", () => {
      expect(tryParseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    });

    it("returns ok:false (never throws) for invalid JSON", () => {
      expect(tryParseJson("{not json")).toEqual({ ok: false });
    });
  });
});
